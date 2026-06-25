export async function handleSync(context) {
  const { tasks, state, projectPath, log, updateStatus, stream, notion } = context;

  log(`[SYNC] Running SYNC phase...`);
  await tasks.loadTasks(); // Ensure tasks are loaded
  const taskId = state.get().currentTaskId;
  const task = tasks._tasks.find((t) => String(t.id) === String(taskId));

  if (task) {
    updateStatus({ phase: 'SYNC', taskTitle: task.title, taskId });
    if (notion && notion.isReady()) {
      try {
        log(`[SYNC] Pushing task ${taskId} progress to Notion`);
        await notion.pushProgress(task);
      } catch (e) {
        log(`[SYNC] Error pushing progress to Notion: ${e.message}`);
      }
    }
  }

  // Go back to IDLE to process next task
  stream.emit('System', 'system', {
    action: 'PhaseChange',
    phase: 'IDLE',
  });
}
