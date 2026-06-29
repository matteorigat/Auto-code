import { basename, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TierSelector } from '../../../src/core/tier-selector.js';
import type { OrchestratorContext } from '../types.js';

export async function handleIdle(context: OrchestratorContext): Promise<void> {
  const { tasks, notion, stream, log, updateStatus, safety, projectPath, state, memory } = context;

  log(`[IDLE] Running IDLE phase...`);

  const currentState = state.get();
  const lastUpdate = currentState?.updatedAt ? new Date(currentState.updatedAt) : new Date();
  const now = new Date();
  if (lastUpdate.toDateString() !== now.toDateString()) {
    log(`[IDLE] New day detected. Resetting storiesCompletedToday count.`);
    state.transition('IDLE', { storiesCompletedToday: 0 });
  }

  if (memory && memory.needsCompaction()) {
    log(`[IDLE] Event stream needs compaction, rotating...`);
    try {
      const { AgentRuntime } = await import('../../runtime.js');
      const tierSelector = new TierSelector();
      const tier = tierSelector.select('IDLE');
      tierSelector.applyTierConfig(tier, projectPath);
      await memory.compact(
        () => new AgentRuntime({ projectPath, agentType: 'summarizer', safety, stream }),
      );
      log(`[IDLE] Compaction completed successfully.`);
    } catch (e: unknown) {
      log(`[IDLE] Compaction failed: ${(e as Error).message}`);
    }
  }

  await tasks.loadTasks();

  const mode = tasks.getExecutionMode();
  const readyTasks = tasks.getReadyTasks(mode);

  const allTasks = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];
  const blocked = allTasks.filter((t: Record<string, unknown>) => t.status === 'blocked').length;
  const done = allTasks.filter((t: Record<string, unknown>) => t.passes).length;

  updateStatus({
    phase: 'IDLE',
    taskTitle: 'Waiting for tasks...',
    tasksCompleted: done,
    tasksBlocked: blocked,
    tasksTotal: allTasks.length,
  });

  if (readyTasks.length > 0) {
    log(`[IDLE] Found ${readyTasks.length} ready task(s). Transitioning to PLAN.`);
    stream.emit('System', 'system', {
      action: 'PhaseChange',
      phase: 'PLAN',
      stateUpdates: { readyTaskIds: readyTasks.map((t) => t.id) },
    });
  } else {
    log(`[IDLE] No ready tasks found. Transitioning to DISCOVER.`);
    stream.emit('System', 'system', {
      action: 'PhaseChange',
      phase: 'DISCOVER',
    });
  }
}
