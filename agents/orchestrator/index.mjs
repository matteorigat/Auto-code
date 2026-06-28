#!/usr/bin/env node
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';

import { getDurableState } from '../../src/core/durable-state.mjs';
import { TaskManager } from '../../src/core/task-manager.mjs';
import { TelegramChannel } from '../../src/bot/telegram-channel.mjs';
import { MemoryManager } from '../../src/core/memory-manager.mjs';
import { Safety } from '../../src/core/safety.mjs';
import NotionAdapter from '../../src/core/notion-adapter.mjs';
import { EventStream } from '../../src/core/event-stream.mjs';
import { TelemetryClient } from '../../src/dashboard/telemetry-client.mjs';
import config from '../../src/config/index.mjs';

async function main() {
  const args = process.argv.slice(2);
  const projectPath = args[0];
  if (!projectPath) {
    console.error('Usage: node agents/orchestrator/index.mjs <project-path>');
    process.exit(1);
  }

  const state = getDurableState(projectPath);
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
  const stream = new EventStream(projectPath);
  const memory = new MemoryManager(projectPath, stream);
  const safety = new Safety(projectPath);
  const telemetry = new TelemetryClient();

  await telegram.initPinned();

  const context = {
    projectPath,
    state,
    notion,
    telegram,
    tasks,
    memory,
    safety,
    stream,
    log: (msg) => {
      const time = new Date().toISOString().slice(11, 19);
      console.log(`[${time}] ${msg}`);
      memory.appendEvent('log', { message: msg });
      telemetry.info('orchestrator', msg);
    },
    updateStatus: (delta) => {
      telegram.updateStatus(delta);
      try {
        const statePath = join(projectPath, '.hydra', 'loop-state.json');
        writeFileSync(statePath, JSON.stringify(telegram._status, null, 2));
      } catch (e) {
        console.error('Ignored error:', e.message);
      }
    },
  };

  // Load phase handlers
  const { handleIdle } = await import('./phases/idle.mjs');
  const { handlePlan } = await import('./phases/plan.mjs');
  const { handleExec } = await import('./phases/exec.mjs');
  const { handleQa } = await import('./phases/qa.mjs');
  const { handleFix } = await import('./phases/fix.mjs');
  const { handleSwarm } = await import('./phases/swarm.mjs');
  const { handleVisualQa } = await import('./phases/visual-qa.mjs');
  const { handleCommit } = await import('./phases/commit.mjs');
  const { handleReflect } = await import('./phases/reflect.mjs');
  const { handleDiscover } = await import('./phases/discover.mjs');
  const { handleSync } = await import('./phases/sync.mjs');
  const { handleWaitHuman } = await import('./phases/wait-human.mjs');

  // Registry pattern
  const phaseHandlers = new Map([
    ['IDLE', handleIdle],
    ['PLAN', handlePlan],
    ['EXEC', handleExec],
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
  const transitionQueue = [];

  const processQueue = async () => {
    if (transitioning) return;
    transitioning = true;

    try {
      while (transitionQueue.length > 0) {
        const payload = transitionQueue.shift();
        const nextPhase = payload.phase;

        const currentState = await state.load();
        context.log(`[EventStream] Transitioning to phase: ${nextPhase}`);
        telemetry.emit('phase.transition', 'orchestrator', `Phase: ${nextPhase}`, {
          data: {
            from: currentState.phase || 'IDLE',
            to: nextPhase,
            taskId: currentState.currentTaskId || null,
            projectSlug: projectPath.split('/').pop(),
          },
        });
        await state.transition(nextPhase, payload.stateUpdates);

        const handler = phaseHandlers.get(nextPhase);
        if (handler) {
          try {
            await handler(context);
          } catch (e) {
            context.log(`Error in phase ${nextPhase}: ${e.stack || e.message}`);
          }
        } else {
          context.log(`Unknown phase: ${nextPhase}`);
        }
      }
    } finally {
      transitioning = false;
    }
  };

  // Event Driven state machine
  stream.on('System', (event) => {
    if (event.payload?.action === 'PhaseChange') {
      if (transitioning) {
        context.log(`[EventStream] Transition blocked — queuing phase: ${event.payload.phase}`);
      }
      transitionQueue.push(event.payload);
      setImmediate(processQueue);
    }
  });

  await tasks.loadTasks();

  context.log(`🔥 Orchestrator starting — ${projectPath}`);
  context.log(`Checkpoint phase: ${checkpoint.phase || 'IDLE'}`);

  // Kickstart
  stream.emit('System', 'system', { action: 'PhaseChange', phase: checkpoint.phase || 'IDLE' });

  // IPC Command Intercept
  if (process.send) {
    process.on('message', (msg) => {
      if (msg.action === 'dashboard_cmd') {
        if (msg.cmd === 'pause') {
          context.log('⏸️ Loop paused by Web Dashboard (IPC)');
          stream.emit('System', 'system', {
            action: 'PhaseChange',
            phase: 'WAIT_HUMAN',
            stateUpdates: { reason: 'Paused by dashboard' },
          });
        } else if (msg.cmd === 'resume') {
          context.log('▶️ Loop resumed by Web Dashboard (IPC)');
          stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
        }
      }
    });
  }
}

main().catch(console.error);
