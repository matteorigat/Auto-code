import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

export async function handleIdle(context) {
  const { tasks, notion, stream, log, updateStatus, safety, projectPath, state, memory } = context;

  log(`[IDLE] Running IDLE phase...`);

  // Reset storiesCompletedToday if a new day has arrived
  const currentState = state.get();
  const lastUpdate = currentState?.updatedAt ? new Date(currentState.updatedAt) : new Date();
  const now = new Date();
  if (lastUpdate.toDateString() !== now.toDateString()) {
    log(`[IDLE] New day detected. Resetting storiesCompletedToday count.`);
    state.transition("IDLE", { storiesCompletedToday: 0 });
  }

  // Memory event stream compaction check
  if (memory && memory.needsCompaction()) {
    log(`[IDLE] Event stream needs compaction, rotating...`);
    try {
      const { AgentRuntime } = await import("../../runtime.mjs");
      await memory.compact(() => new AgentRuntime({ projectPath, agentType: "summarizer", safety, stream }));
      log(`[IDLE] Compaction completed successfully.`);
    } catch (e) {
      log(`[IDLE] Compaction failed: ${e.message}`);
    }
  }

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
