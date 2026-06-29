import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TierSelector } from '../../../src/core/tier-selector.js';
import type { OrchestratorContext } from '../types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export async function handleExec(context: OrchestratorContext): Promise<void> {
  const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;

  log(`[EXEC] Running EXEC phase...`);
  const currentState = state.get() || ({} as Record<string, unknown>);
  const execTaskIds = ((currentState as Record<string, unknown[]>).execTaskIds || []) as string[];

  if (!execTaskIds.length) {
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
    return;
  }

  const tasksArr = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];
  const tasksToRun = execTaskIds
    .map((id: string) => tasksArr.find((t: Record<string, unknown>) => String(t.id) === String(id)))
    .filter(Boolean) as Record<string, unknown>[];
  let mode = tasks.getExecutionMode() as string;

  if (mode === 'parallel') {
    let dockerAvailable = false;
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('docker', ['ps'], { stdio: 'ignore' });
      dockerAvailable = true;
    } catch (e: unknown) {
      console.error('Ignored error:', (e as Error).message);
    }
    if (!dockerAvailable) {
      log(`[EXEC] Docker unavailable. Falling back to sequential mode.`);
      mode = 'sequential';
    }
  }

  log(
    `[EXEC] Running builder for tasks: ${tasksToRun.map((t: Record<string, unknown>) => t.id).join(', ')} (${mode})`,
  );

  interface TaskResult {
    task: Record<string, unknown>;
    success: boolean;
    error?: string;
  }

  const runTask = (task: Record<string, unknown>): Promise<TaskResult> => {
    return new Promise<TaskResult>((resolve) => {
      const ws = (task.workspacePath as string) || projectPath;
      updateStatus({ phase: 'EXEC', taskTitle: task.title, taskId: task.id });

      state.transition('EXEC', {
        currentTaskId: task.id,
        currentStory: task.title,
      });

      log(`[EXEC] [${task.id}] — Starting Isolated Worker Process`);

      const tierSelector = new TierSelector();
      const tier = tierSelector.select('EXEC');
      tierSelector.applyTierConfig(tier, ws);

      const workerPath = join(__dirname, '../../workers/builder-worker.js');
      const worker = fork(workerPath, [], {
        env: process.env,
        stdio: 'inherit',
      });

      worker.on('message', (msg: Record<string, unknown>) => {
        if (msg.type === 'EVENT') {
          const { actor, source, payload } = msg.event as Record<string, unknown>;
          stream.emit(actor as string, source as string, payload as Record<string, unknown>);
        } else if (msg.type === 'STATUS') {
          updateStatus({ phase: msg.phase });
        } else if (msg.type === 'DONE') {
          const result = msg.result as Record<string, unknown>;
          resolve({ task, success: result.ok as boolean, error: result.error as string });
          worker.kill();
        }
      });

      worker.on('error', (e: Error) => {
        resolve({ task, success: false, error: e.message });
      });

      worker.on('exit', (code: number | null) => {
        if (code !== 0) {
          resolve({ task, success: false, error: `Worker exited with code ${code}` });
        }
      });

      worker.send({
        type: 'START',
        projectPath: ws,
        task,
        safetyOptions: {
          allowedDirs: [ws],
          maxCycleMs:
            safety &&
            typeof (safety as unknown as Record<string, unknown>).maxCycleMs === 'function'
              ? (safety as unknown as Record<string, () => number>).maxCycleMs()
              : 900000,
        },
      });
    });
  };

  if (mode === 'parallel') {
    const results = await Promise.all(tasksToRun.map((t: Record<string, unknown>) => runTask(t)));
    const failed = results.filter((r: TaskResult) => !r.success);

    if (failed.length > 0) {
      log(`[EXEC] ${failed.length} tasks failed in parallel mode.`);
      stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
    } else {
      stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'QA',
        stateUpdates: {
          qaTaskIds: execTaskIds,
          currentTaskId: execTaskIds[0],
          currentStory: tasksToRun[0]?.title || 'Multiple tasks',
        },
      });
    }
  } else {
    const res = await runTask(tasksToRun[0]);
    if (res.success) {
      stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'QA',
        stateUpdates: {
          qaTaskIds: [tasksToRun[0].id],
          currentTaskId: tasksToRun[0].id,
          currentStory: tasksToRun[0].title,
        },
      });
    } else {
      stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'FIX',
        stateUpdates: {
          previousError: res.error,
          fixTaskId: tasksToRun[0].id,
          currentTaskId: tasksToRun[0].id,
          currentStory: tasksToRun[0].title,
        },
      });
    }
  }
}
