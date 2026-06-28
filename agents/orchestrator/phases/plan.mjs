import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { TaskManager } from '../../../src/core/task-manager.mjs';
import { TierSelector } from '../../../src/core/tier-selector.mjs';

export async function handlePlan(context) {
  const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;
  const { AgentRuntime } = await import('../../runtime.mjs');

  log(`[PLAN] Running PLAN phase...`);
  const currentState = state.get();
  const readyTaskIds = currentState.readyTaskIds || [];

  if (!readyTaskIds.length) {
    log(`[PLAN] No tasks to plan. Back to IDLE.`);
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
    return;
  }

  const tasksToExec = [];

  for (const taskId of readyTaskIds) {
    const task = tasks._tasks.find((t) => String(t.id) === String(taskId));
    if (!task) continue;

    updateStatus({ phase: 'PLAN', taskTitle: task.title, taskId: task.id });

    // Split logic if needed
    if (tasks.needsSplitting(task)) {
      log(`[PLAN] Story ${task.id} too large — splitting`);
      const parts = tasks.splitStory(task);
      tasks._tasks = tasks._tasks.filter((t) => String(t.id) !== String(task.id));
      for (const p of parts) tasks.addStory(p);
      // Wait for next IDLE cycle to pick up the split tasks
      stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
      return;
    }

    log(`[PLAN] Planning task: ${task.id} ${task.title}`);

    // Init workspace for task
    const projectDir = _resolveProjectDir(task, projectPath);
    task.workspacePath = projectDir;
    task._projectSlug = basename(projectDir);

    tasks._syncProjectFiles(task);

    // Dynamic SDD Planning Pipeline: task-planner -> architect -> reviewer
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
    await taskPlanner.run(300000); // 5 min

    log(`[PLAN] [${task.id}] Running architect to generate technical proposal`);
    const architect = new AgentRuntime({
      projectPath: projectDir,
      agentType: 'architect',
      task,
      safety,
      stream,
      tasks: localTasks,
    });
    await architect.run(300000); // 5 min

    log(`[PLAN] [${task.id}] Running reviewer to review technical proposal`);
    const reviewer = new AgentRuntime({
      projectPath: projectDir,
      agentType: 'reviewer',
      task,
      safety,
      stream,
      tasks: localTasks,
    });
    await reviewer.run(300000); // 5 min

    tasksToExec.push(task.id);
  }

  // Transition directly to EXEC (sequential mode, skip SWARM negotiation)
  stream.emit('System', 'system', {
    action: 'PhaseChange',
    phase: 'EXEC',
    stateUpdates: { execTaskIds: tasksToExec },
  });
}

// Minimal resolver
function _resolveProjectDir(story, projectPath) {
  if (story.workspacePath && existsSync(story.workspacePath)) return story.workspacePath;
  if (story._projectSlug) return join(projectPath, 'projects', story._projectSlug);
  return projectPath;
}
