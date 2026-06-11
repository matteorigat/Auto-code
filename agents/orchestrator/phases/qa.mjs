import { QualityGate } from "../../../src/core/quality-gate.mjs";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export async function handleQa(context) {
  const { tasks, stream, log, updateStatus, projectPath, state } = context;

  log(`[QA] Running QA phase...`);
  const currentState = state.get();
  const qaTaskIds = currentState.qaTaskIds || [];

  if (!qaTaskIds.length) {
    stream.emit("System", "system", { action: "PhaseChange", phase: "IDLE" });
    return;
  }

  const gate = new QualityGate(projectPath);
  let allPassed = true;

  for (const taskId of qaTaskIds) {
    const task = tasks._tasks.find(t => String(t.id) === String(taskId));
    if (!task) continue;

    const ws = task.workspacePath || projectPath;
    updateStatus({ phase: "QA", taskTitle: task.title, taskId: task.id });

    // Update state checkpoint with current task details during QA
    state.transition("QA", {
      currentTaskId: task.id,
      currentStory: task.title
    });
    
    // Clean up swarm-consensus.md if it exists
    const consensusPath = join(ws, ".hydra", "swarm-consensus.md");
    try {
      if (existsSync(consensusPath)) {
        unlinkSync(consensusPath);
        log(`[QA] Cleaned up swarm-consensus.md in ${ws}`);
      }
    } catch (e) {
      log(`[QA] Failed to clean up swarm-consensus.md: ${e.message}`);
    }
    
    log(`[QA] Running gates for ${taskId} inside Docker sandbox`);
    
    // Instead of raw execSync, QualityGate will use DockerSandboxController internally
    const qa = await gate.run({ cwd: ws, taskId: task.id });
    
    if (qa.passed) {
      log(`[QA] ${taskId} PASSED`);
      // Non segniamo subito come passato, lo farà VISUAL_QA
      // tasks.markPass(taskId);
      // In full flow, this goes to COMMIT phase next
    } else {
      log(`[QA] ${taskId} FAILED`);
      allPassed = false;
      // In full flow, goes to FIX phase
      const reflectionCount = currentState.reflectionCount || 0;
      stream.emit("System", "system", { 
        action: "PhaseChange", 
        phase: "FIX", 
        stateUpdates: { 
          previousError: qa.results.filter(r => !r.passed).map(r => r.output).join("\n"), 
          fixTaskId: taskId,
          reflectionCount: reflectionCount + 1
        } 
      });
      return;
    }
  }

  if (allPassed) {
    stream.emit("System", "system", { action: "PhaseChange", phase: "VISUAL_QA", stateUpdates: { visualQaTaskIds: qaTaskIds } });
  }
}
