import { QualityGate } from '../../../src/core/quality-gate.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorContext } from '../types.js';

export async function handleQa(context: OrchestratorContext): Promise<void> {
  const { tasks, stream, log, updateStatus, projectPath, state } = context;

  log(`[QA] Running QA phase...`);
  const currentState = state.get() || ({} as Record<string, unknown>);
  const qaTaskIds = (currentState as Record<string, unknown[]>).qaTaskIds || [];
  const tasksArr = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];

  if (!qaTaskIds.length) {
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
    return;
  }

  const gate = new QualityGate(projectPath);

  for (const taskId of qaTaskIds) {
    const task = tasksArr.find((t: Record<string, unknown>) => String(t.id) === String(taskId));
    if (!task) continue;

    const ws = (task.workspacePath as string) || projectPath;
    updateStatus({ phase: 'QA', taskTitle: task.title, taskId: task.id });

    state.transition('QA', {
      currentTaskId: task.id,
      currentStory: task.title,
    });

    const consensusPath = join(ws, '.hydra', 'swarm-consensus.md');
    try {
      if (existsSync(consensusPath)) {
        unlinkSync(consensusPath);
        log(`[QA] Cleaned up swarm-consensus.md in ${ws}`);
      }
    } catch (e: unknown) {
      log(`[QA] Failed to clean up swarm-consensus.md: ${(e as Error).message}`);
    }

    log(`[QA] Running gates for ${taskId} inside Docker sandbox`);

    const qa = await gate.run({ cwd: ws, taskId: task.id as string });

    if (qa.passed) {
      log(`[QA] ${taskId} PASSED`);
    } else {
      log(`[QA] ${taskId} FAILED`);
      const reflectionCount = (currentState as Record<string, number>).reflectionCount || 0;
      stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'FIX',
        stateUpdates: {
          previousError: qa.results
            .filter((r: { passed: boolean }) => !r.passed)
            .map((r: { output: string }) => r.output)
            .join('\n'),
          fixTaskId: taskId,
          reflectionCount: reflectionCount + 1,
        },
      });
      return;
    }
  }

  stream.emit('System', 'system', {
    action: 'PhaseChange',
    phase: 'VISUAL_QA',
    stateUpdates: { visualQaTaskIds: qaTaskIds },
  });
}
