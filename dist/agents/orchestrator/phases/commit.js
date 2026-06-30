import { execFileSync } from 'node:child_process';
export async function handleCommit(context) {
    const { tasks, state, projectPath, log, updateStatus, safety, stream } = context;
    const taskId = state.get()?.currentTaskId;
    const tasksArray = tasks._tasks;
    const task = tasksArray?.find((t) => String(t.id) === String(taskId));
    const ws = task?.workspacePath || projectPath;
    updateStatus({ phase: 'COMMIT', taskTitle: `[${taskId}] Preparing commit...`, taskId });
    log(`[COMMIT] git commit on branch in ${ws}`);
    try {
        execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ws, timeout: 5000 });
    }
    catch {
        execFileSync('git', ['init'], { cwd: ws, timeout: 10000 });
        execFileSync('git', ['config', 'user.email', 'hydra-loop@opencode.ai'], {
            cwd: ws,
            timeout: 5000,
        });
        execFileSync('git', ['config', 'user.name', 'Hydra Loop'], { cwd: ws, timeout: 5000 });
    }
    try {
        updateStatus({ phase: 'COMMIT', taskTitle: `[${taskId}] Committing code changes: "${state.get()?.currentStory}"...`, taskId });
        execFileSync('git', ['add', '-A'], { cwd: ws, timeout: 15000 });
        execFileSync('git', ['commit', '-m', `feat(${taskId}): ${state.get()?.currentStory}`], {
            cwd: ws,
            timeout: 15000,
        });
        log(`[COMMIT] Committed feat(${taskId}): ${state.get()?.currentStory} on task branch`);
    }
    catch (e) {
        log(`[COMMIT] Error — git commit on branch failed: ${e.message}`);
    }
    updateStatus({ phase: 'COMMIT', taskTitle: `[${taskId}] Merging task branch into base branch...`, taskId });
    log(`[COMMIT] merging task branch back to base branch`);
    const merged = taskId ? safety.mergeTaskBranch(taskId, ws) : false;
    if (merged) {
        log(`[COMMIT] Successfully merged task branch for US-${taskId} to base branch`);
    }
    else {
        log(`[COMMIT] Error — failed to merge task branch. Reverting to base branch.`);
    }
    const taskObj = task;
    if (taskObj) {
        const tasksWithProject = tasks;
        if (taskObj._projectSlug) {
            tasksWithProject._syncProjectFiles?.(taskObj);
        }
        else {
            tasksWithProject._persist?.();
        }
    }
    const currentToday = (state.get()?.storiesCompletedToday || 0) + 1;
    stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'REFLECT',
        stateUpdates: { storiesCompletedToday: currentToday },
    });
}
