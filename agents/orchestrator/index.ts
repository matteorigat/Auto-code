#!/usr/bin/env node
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';

import { getDurableState } from '../../src/core/durable-state.js';
import { TaskManager } from '../../src/core/task-manager.js';
import { TelegramChannel } from '../../src/bot/telegram-channel.js';
import { MemoryManager } from '../../src/core/memory-manager.js';
import { Safety } from '../../src/core/safety.js';
import NotionAdapter from '../../src/core/notion-adapter.js';
import { EventStream } from '../../src/core/event-stream.js';
import { TelemetryClient } from '../../src/dashboard/telemetry-client.js';
import config from '../../src/config/index.js';
import type { OrchestratorContext } from './types.js';
import type { LoopState } from '../../src/core/durable-state.js';
import type { StreamEvent } from '../../src/core/event-stream.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const projectPath = args[0];
  if (!projectPath) {
    console.error('Usage: node agents/orchestrator/index.js <project-path>');
    process.exit(1);
  }

  const stream = new EventStream(projectPath);
  const state = getDurableState(projectPath, stream);
  const checkpoint = await state.load();

  const notion = new NotionAdapter({
    token: config.notion.apiToken,
    databaseId: config.notion.databaseId,
    pageId: config.notion.pageId,
  });

  const telegram = new TelegramChannel({
    botToken: config.telegram.botToken,
    chatId: config.system.chatId,
  });

  const tasks = new TaskManager({ projectPath, notionAdapter: notion });
  const memory = new MemoryManager(projectPath, stream);
  const safety = new Safety(projectPath);
  const telemetry = new TelemetryClient();

  await telegram.initPinned();

  const context: OrchestratorContext = {
    projectPath,
    state,
    notion,
    telegram,
    tasks,
    memory,
    safety,
    stream,
    log: (msg: string) => {
      const time = new Date().toISOString().slice(11, 19);
      console.log(`[${time}] ${msg}`);
      memory.appendEvent('log', { message: msg });
      telemetry.info('orchestrator', msg);
    },
    updateStatus: (delta: Record<string, unknown>) => {
      if (!delta.project) {
        const taskId = delta.taskId || state.get()?.currentTaskId;
        if (taskId) {
          const tasksArr = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];
          const task = tasksArr.find((t) => String(t.id) === String(taskId));
          if (task?._projectSlug) {
            delta.project = task._projectSlug;
          }
        }
      }
      telegram.updateStatus(delta);
      try {
        const statePath = join(projectPath, '.hydra', 'loop-state.json');
        writeFileSync(
          statePath,
          JSON.stringify(telegram.getStatus() ?? {}, null, 2),
        );
      } catch (e: unknown) {
        console.error('Ignored error:', (e as Error).message);
      }
    },
  };

  const { handleIdle } = await import('./phases/idle.js');
  const { handlePlan } = await import('./phases/plan.js');
  const { handleExec } = await import('./phases/exec.js');
  const { handleQa } = await import('./phases/qa.js');
  const { handleFix } = await import('./phases/fix.js');
  const { handleSwarm } = await import('./phases/swarm.js');
  const { handleVisualQa } = await import('./phases/visual-qa.js');
  const { handleCommit } = await import('./phases/commit.js');
  const { handleReflect } = await import('./phases/reflect.js');
  const { handleDiscover } = await import('./phases/discover.js');
  const { handleSync } = await import('./phases/sync.js');
  const { handleWaitHuman } = await import('./phases/wait-human.js');

  const phaseHandlers: Map<string, (ctx: OrchestratorContext) => Promise<void>> = new Map([
    ['IDLE', handleIdle],
    ['PLAN', handlePlan],
    ['EXEC', handleExec],
    ['CODE', handleExec],
    ['QA', handleQa],
    ['VISUAL_QA', handleVisualQa],
    ['FIX', handleFix],
    ['SWARM', handleSwarm],
    ['COMMIT', handleCommit],
    ['REFLECT', handleReflect],
    ['SYNC', handleSync],
    ['DISCOVER', handleDiscover],
    ['WAIT_HUMAN', handleWaitHuman],
  ]);

  let transitioning = false;
  const transitionQueue: { phase: string; stateUpdates?: Record<string, unknown> }[] = [];

  const processQueue = async () => {
    if (transitioning) return;
    transitioning = true;

    try {
      while (transitionQueue.length > 0) {
        const payload = transitionQueue.shift()!;

        const currentState = await state.load();
        context.log(`[EventStream] Transitioning to phase: ${payload.phase}`);

        const tasksArr = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];
        const activeTaskId = payload.stateUpdates?.currentTaskId || currentState.currentTaskId;
        const activeTask = tasksArr.find((t) => String(t.id) === String(activeTaskId));
        const projectSlug = activeTask?._projectSlug || (payload.stateUpdates as any)?.project || (currentState as any)?.project || projectPath.split('/').pop();

        telemetry.emit('phase.transition', 'orchestrator', `Phase: ${payload.phase}`, {
          data: {
            from: currentState.phase || 'IDLE',
            to: payload.phase,
            taskId: activeTaskId || null,
            projectSlug,
          },
        });
        await state.transition(payload.phase as LoopState['phase'], payload.stateUpdates);

        const handler = phaseHandlers.get(payload.phase);
        if (handler) {
          try {
            await handler(context);
          } catch (e: unknown) {
            context.log(
              `Error in phase ${payload.phase}: ${(e as Error).stack || (e as Error).message}`,
            );
          }
        } else {
          context.log(`Unknown phase: ${payload.phase}`);
        }
      }
    } finally {
      transitioning = false;
    }
  };

  stream.on('System', (event: StreamEvent) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload?.action === 'PhaseChange') {
      if (transitioning) {
        context.log(`[EventStream] Transition blocked — queuing phase: ${payload.phase}`);
      }
      transitionQueue.push(payload as { phase: string; stateUpdates?: Record<string, unknown> });
      setImmediate(processQueue);
    }
  });

  await tasks.loadTasks();

  context.log(`🔥 Orchestrator starting — ${projectPath}`);
  context.log(`Checkpoint phase: ${checkpoint.phase || 'IDLE'}`);

  stream.emit('System', 'system', { action: 'PhaseChange', phase: checkpoint.phase || 'IDLE' });

  if (process.send) {
    process.on('message', (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (m.action === 'dashboard_cmd') {
        if (m.cmd === 'pause') {
          context.log('⏸️ Loop paused by Web Dashboard (IPC)');
          stream.emit('System', 'system', {
            action: 'PhaseChange',
            phase: 'WAIT_HUMAN',
            stateUpdates: { reason: 'Paused by dashboard' },
          });
        } else if (m.cmd === 'resume') {
          context.log('▶️ Loop resumed by Web Dashboard (IPC)');
          stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
        }
      }
    });
  }
}

main().catch(console.error);
