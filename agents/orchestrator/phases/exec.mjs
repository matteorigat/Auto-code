import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TierSelector } from '../../../src/core/tier-selector.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export async function handleExec(context) {
  const { tasks, stream, log, updateStatus, projectPath, state, safety, memory } = context;

  log(`[EXEC] Running EXEC phase...`);
  const currentState = state.get();
  const execTaskIds = currentState.execTaskIds || [];

  if (!execTaskIds.length) {
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
    return;
  }

  const tasksToRun = execTaskIds
    .map((id) => tasks._tasks.find((t) => String(t.id) === String(id)))
    .filter(Boolean);
  let mode = tasks.getExecutionMode();

  if (mode === 'parallel') {
    let dockerAvailable = false;
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('docker', ['ps'], { stdio: 'ignore' });
      dockerAvailable = true;
    } catch (e) {
      console.error('Ignored error:', e.message);
    }
    if (!dockerAvailable) {
      log(
        `[EXEC] ⚠️ Docker unavailable. Impossible to execute tasks in parallel on the host (race condition risk). Falling back to sequential mode.`,
      );
      mode = 'sequential';
    }
  }

  log(`[EXEC] Running builder for tasks: ${tasksToRun.map((t) => t.id).join(', ')} (${mode})`);

  const runTask = (task) => {
    return new Promise((resolve) => {
      const ws = task.workspacePath || projectPath;
      updateStatus({ phase: 'EXEC', taskTitle: task.title, taskId: task.id });

      // Update state checkpoint with current task details during execution
      state.transition('EXEC', {
        currentTaskId: task.id,
        currentStory: task.title,
      });

      log(`[EXEC] [${task.id}] — Starting Isolated Worker Process`);

      const tierSelector = new TierSelector();
      const tier = tierSelector.select('EXEC');
      tierSelector.applyTierConfig(tier, ws);

      const workerPath = join(__dirname, '../../workers/builder-worker.mjs');
      const worker = fork(workerPath, [], {
        env: process.env, // Pass env vars like API keys
        stdio: 'inherit', // Stream logs to main console
      });

      worker.on('message', (msg) => {
        if (msg.type === 'EVENT') {
          const { actor, source, payload } = msg.event;
          stream.emit(actor, source, payload);
        } else if (msg.type === 'STATUS') {
          updateStatus({ phase: msg.phase });
        } else if (msg.type === 'DONE') {
          resolve({ task, success: msg.result.ok, error: msg.result.error });
          worker.kill();
        }
      });

      worker.on('error', (e) => {
        resolve({ task, success: false, error: e.message });
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          resolve({ task, success: false, error: `Worker exited with code ${code}` });
        }
      });

      worker.send({
        type: 'START',
        projectPath: ws,
        task,
        safetyOptions: {
          // Recreate safety config if necessary
          allowedDirs: [ws],
          maxCycleMs: safety.maxCycleMs ? safety.maxCycleMs() : 900000,
        },
      });
    });
  };

  if (mode === 'parallel') {
    // Run all tasks concurrently
    const results = await Promise.all(tasksToRun.map((t) => runTask(t)));
    // Gather failures to potentially push to FIX
    const failed = results.filter((r) => !r.success);

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
    // Sequential fallback
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
