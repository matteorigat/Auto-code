import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

export async function handleIdle(context) {
  const { tasks, notion, stream, log, updateStatus, safety, projectPath } = context;

  log(`[IDLE] Running IDLE phase...`);

  // Sync tasks from Notion and local PRD
  await tasks.loadTasks();

  const mode = tasks.getExecutionMode();
  const readyTasks = tasks.getReadyTasks(mode);
  
  const allTasks = tasks._tasks || [];
  const blocked = allTasks.filter(t => t.status === "blocked").length;
  const done = allTasks.filter(t => t.passes).length;
  
  updateStatus({ 
    phase: "IDLE", 
    taskTitle: "Waiting for tasks...", 
    tasksCompleted: done, 
    tasksBlocked: blocked, 
    tasksTotal: allTasks.length 
  });

  if (readyTasks.length > 0) {
    log(`[IDLE] Found ${readyTasks.length} ready task(s). Transitioning to PLAN.`);
    // We emit an event to move to PLAN, passing the array of ready tasks
    stream.emit("System", "system", { 
      action: "PhaseChange", 
      phase: "PLAN", 
      stateUpdates: { readyTaskIds: readyTasks.map(t => t.id) } 
    });
  } else {
    log(`[IDLE] No ready tasks found. Transitioning to DISCOVER.`);
    stream.emit("System", "system", { 
      action: "PhaseChange", 
      phase: "DISCOVER" 
    });
  }
}
