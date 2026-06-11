import { execSync } from "node:child_process";

export async function handleCommit(context) {
  const { tasks, state, projectPath, log, updateStatus, safety, stream } = context;

  const taskId = state.get().currentTaskId;
  const task = tasks._tasks.find((t) => String(t.id) === String(taskId));
  const ws = task?.workspacePath || projectPath;
  
  updateStatus({ phase: "COMMIT", taskTitle: state.get().currentStory, taskId });
  log(`[COMMIT] git commit on branch in ${ws}`);

  try { 
    execSync("git rev-parse --git-dir", { cwd: ws, shell: "/bin/bash", timeout: 5000 }); 
  } catch {
    execSync("git init", { cwd: ws, shell: "/bin/bash", timeout: 10000 });
    execSync("git config user.email hydra-loop@opencode.ai && git config user.name 'Hydra Loop'", { cwd: ws, shell: "/bin/bash", timeout: 5000 });
  }

  try {
    execSync(`git add -A && git commit -m "feat(${taskId}): ${state.get().currentStory}"`, { cwd: ws, shell: "/bin/bash", timeout: 15000 });
    log(`[COMMIT] Committed feat(${taskId}): ${state.get().currentStory} on task branch`);
  } catch (e) {
    log(`[COMMIT] Error — git commit on branch failed: ${e.message}`);
  }

  log(`[COMMIT] merging task branch back to base branch`);
  const merged = safety.mergeTaskBranch(taskId, ws);
  if (merged) {
    log(`[COMMIT] Successfully merged task branch for US-${taskId} to base branch`);
  } else {
    log(`[COMMIT] Error — failed to merge task branch. Reverting to base branch.`);
  }

  // Sync back to PRD
  if (task) {
    if (task._projectSlug) {
      tasks._syncProjectFiles(task);
    } else {
      // Fallback
      tasks._persist();
    }
  }

  stream.emit("System", "system", { 
    action: "PhaseChange", 
    phase: "REFLECT"
  });
}
