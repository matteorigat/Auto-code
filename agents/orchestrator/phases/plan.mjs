import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export async function handlePlan(context) {
  const { tasks, stream, log, updateStatus, projectPath, state } = context;

  log(`[PLAN] Running PLAN phase...`);
  const currentState = state.get();
  const readyTaskIds = currentState.readyTaskIds || [];

  if (!readyTaskIds.length) {
    log(`[PLAN] No tasks to plan. Back to IDLE.`);
    stream.emit("System", "system", { action: "PhaseChange", phase: "IDLE" });
    return;
  }

  const tasksToExec = [];

  for (const taskId of readyTaskIds) {
    const task = tasks._tasks.find(t => String(t.id) === String(taskId));
    if (!task) continue;

    updateStatus({ phase: "PLAN", taskTitle: task.title, taskId: task.id });
    
    // Split logic if needed
    if (tasks.needsSplitting(task)) {
      log(`[PLAN] Story ${task.id} too large — splitting`);
      const parts = tasks.splitStory(task);
      tasks._tasks = tasks._tasks.filter(t => String(t.id) !== String(task.id));
      for (const p of parts) tasks.addStory(p);
      // Wait for next IDLE cycle to pick up the split tasks
      stream.emit("System", "system", { action: "PhaseChange", phase: "IDLE" });
      return;
    }

    log(`[PLAN] Planning task: ${task.id} ${task.title}`);
    
    // Init workspace for task
    const projectDir = _resolveProjectDir(task, projectPath, tasks);
    task.workspacePath = projectDir;
    task._projectSlug = basename(projectDir);
    
    tasks._syncProjectFiles(task);

    // In a full implementation, we'd run task-planner AgentRuntime here 
    // to generate SDD artifacts if they are missing.
    // For now, we consider it planned.
    tasksToExec.push(task.id);
  }

  // Transition to SWARM with tasks ready for multi-agent negotiation
  stream.emit("System", "system", { 
    action: "PhaseChange", 
    phase: "SWARM", 
    stateUpdates: { execTaskIds: tasksToExec } 
  });
}

// Minimal resolver
function _resolveProjectDir(story, projectPath, tasks) {
  if (story.workspacePath && existsSync(story.workspacePath)) return story.workspacePath;
  if (story._projectSlug) return join(projectPath, "projects", story._projectSlug);
  return projectPath;
}
