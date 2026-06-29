export async function handleSync(context) {
    const { tasks, state, projectPath, log, updateStatus, stream, notion } = context;
    log(`[SYNC] Running SYNC phase...`);
    await tasks.loadTasks();
    const taskId = state.get()?.currentTaskId;
    const tasksArray = tasks._tasks;
    const task = tasksArray?.find((t) => String(t.id) === String(taskId));
    if (task) {
        updateStatus({ phase: 'SYNC', taskTitle: task.title, taskId });
        if (notion && notion.isReady()) {
            try {
                log(`[SYNC] Pushing task ${taskId} progress to Notion`);
                await notion.pushProgress(task);
            }
            catch (e) {
                log(`[SYNC] Error pushing progress to Notion: ${e.message}`);
            }
        }
    }
    stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'IDLE',
    });
}
