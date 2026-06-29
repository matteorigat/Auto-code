import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { TaskManager } from '../../../src/core/task-manager.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
export async function handlePlan(context) {
    const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;
    const { AgentRuntime } = await import('../../runtime.js');
    log(`[PLAN] Running PLAN phase...`);
    const currentState = state.get() || {};
    const readyTaskIds = currentState.readyTaskIds || [];
    if (!readyTaskIds.length) {
        log(`[PLAN] No tasks to plan. Back to IDLE.`);
        stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
        return;
    }
    const tasksToExec = [];
    const tasksArr = tasks._tasks || [];
    for (const taskId of readyTaskIds) {
        const task = tasksArr.find((t) => String(t.id) === String(taskId));
        if (!task)
            continue;
        updateStatus({ phase: 'PLAN', taskTitle: task.title, taskId: task.id });
        if (tasks.needsSplitting(task)) {
            log(`[PLAN] Story ${task.id} too large — splitting`);
            const parts = tasks.splitStory(task);
            const newTasks = tasksArr.filter((t) => String(t.id) !== String(task.id));
            tasks._tasks = newTasks;
            for (const p of parts)
                tasks.addStory(p);
            stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
            return;
        }
        log(`[PLAN] Planning task: ${task.id} ${task.title}`);
        const projectDir = _resolveProjectDir(task, projectPath);
        task.workspacePath = projectDir;
        task._projectSlug = basename(projectDir);
        tasks._syncProjectFiles(task);
        const localTasks = new TaskManager({ projectPath: projectDir });
        const tierSelector = new TierSelector();
        const tier = tierSelector.select('PLAN');
        tierSelector.applyTierConfig(tier, projectDir);
        log(`[PLAN] [${task.id}] Running task-planner to generate tests and details`);
        const taskPlanner = new AgentRuntime({
            projectPath: projectDir,
            agentType: 'task-planner',
            task,
            safety,
            stream,
            tasks: localTasks,
        });
        await taskPlanner.run(300000);
        log(`[PLAN] [${task.id}] Running architect to generate technical proposal`);
        const architect = new AgentRuntime({
            projectPath: projectDir,
            agentType: 'architect',
            task,
            safety,
            stream,
            tasks: localTasks,
        });
        await architect.run(300000);
        log(`[PLAN] [${task.id}] Running reviewer to review technical proposal`);
        const reviewer = new AgentRuntime({
            projectPath: projectDir,
            agentType: 'reviewer',
            task,
            safety,
            stream,
            tasks: localTasks,
        });
        await reviewer.run(300000);
        tasksToExec.push(task.id);
    }
    stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'EXEC',
        stateUpdates: { execTaskIds: tasksToExec },
    });
}
function _resolveProjectDir(story, projectPath) {
    if (story.workspacePath && existsSync(story.workspacePath))
        return story.workspacePath;
    if (story._projectSlug)
        return join(projectPath, 'projects', story._projectSlug);
    return projectPath;
}
