import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { TaskManager } from '../../../src/core/task-manager.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
import type { OrchestratorContext } from '../types.js';

export async function handlePlan(context: OrchestratorContext): Promise<void> {
  const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;
  const { AgentRuntime } = await import('../../runtime.js');

  log(`[PLAN] Running PLAN phase...`);
  const currentState = state.get() || ({} as Record<string, unknown>);
  const readyTaskIds = (currentState as Record<string, unknown[]>).readyTaskIds || [];

  if (!readyTaskIds.length) {
    log(`[PLAN] No tasks to plan. Back to IDLE.`);
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
    return;
  }

  const tasksToExec: string[] = [];
  const tasksArr = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];

  for (const taskId of readyTaskIds) {
    const task = tasksArr.find((t: Record<string, unknown>) => String(t.id) === String(taskId));
    if (!task) continue;

    updateStatus({ phase: 'PLAN', taskTitle: task.title, taskId: task.id });

    if (tasks.needsSplitting(task as never)) {
      log(`[PLAN] Story ${task.id} too large — splitting`);
      const parts = tasks.splitStory(task as never);
      const newTasks = tasksArr.filter(
        (t: Record<string, unknown>) => String(t.id) !== String(task.id),
      );
      (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks = newTasks;
      for (const p of parts) tasks.addStory(p);
      stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
      return;
    }

    log(`[PLAN] Planning task: ${task.id} ${task.title}`);

    const projectDir = _resolveProjectDir(task, projectPath);
    task.workspacePath = projectDir;
    task._projectSlug = basename(projectDir);

    (tasks as unknown as Record<string, (t: Record<string, unknown>) => void>)._syncProjectFiles(
      task,
    );

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

    tasksToExec.push(task.id as string);
  }

  stream.emit('System', 'system', {
    action: 'PhaseChange',
    phase: 'EXEC',
    stateUpdates: { execTaskIds: tasksToExec },
  });
}

function _resolveProjectDir(story: Record<string, unknown>, projectPath: string): string {
  if (story.workspacePath && existsSync(story.workspacePath as string))
    return story.workspacePath as string;
  if (story._projectSlug) return join(projectPath, 'projects', story._projectSlug as string);
  return projectPath;
}
