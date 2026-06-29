import type { OrchestratorContext } from '../types.js';

export async function handleSync(context: OrchestratorContext): Promise<void> {
  const { tasks, state, projectPath, log, updateStatus, stream, notion } = context;

  log(`[SYNC] Running SYNC phase...`);
  await tasks.loadTasks();
  const taskId = state.get()?.currentTaskId;
  const tasksArray = (tasks as unknown as Record<string, unknown[]>)._tasks as Record<
    string,
    unknown
  >[];
  const task = tasksArray?.find((t: Record<string, unknown>) => String(t.id) === String(taskId));

  if (task) {
    updateStatus({ phase: 'SYNC', taskTitle: task.title, taskId });
    if (notion && notion.isReady()) {
      try {
        log(`[SYNC] Pushing task ${taskId} progress to Notion`);
        await notion.pushProgress(task as Record<string, unknown>);
      } catch (e: unknown) {
        log(`[SYNC] Error pushing progress to Notion: ${(e as Error).message}`);
      }
    }
  }

  stream.emit('System', 'system', {
    action: 'PhaseChange',
    phase: 'IDLE',
  });
}
