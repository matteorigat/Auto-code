import { AgentRuntime } from "../../runtime.mjs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

export async function handleSwarm(context) {
  const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;

  log(`[SWARM] Running SWARM phase...`);
  const currentState = state.get();
  const execTaskIds = currentState.execTaskIds || [];

  if (!execTaskIds.length) {
    stream.emit("System", "system", { action: "PhaseChange", phase: "IDLE" });
    return;
  }

  const tasksToRun = execTaskIds.map(id => tasks._tasks.find(t => String(t.id) === String(id))).filter(Boolean);
  const mode = tasks.getExecutionMode();

  log(`[SWARM] Swarming for tasks: ${tasksToRun.map(t => t.id).join(", ")} (${mode})`);

  const runSwarm = async (task) => {
    const ws = task.workspacePath || projectPath;
    updateStatus({ phase: "SWARM", taskTitle: task.title, taskId: task.id });
    
    log(`[SWARM] [${task.id}] — Architect vs Reviewer Negotiation`);

    // 1. Architect Proposes
    const architect = new AgentRuntime({ projectPath: ws, agentType: "architect", task, safety, stream });
    architect.task = { ...task, title: `Architecture Proposal: ${task.title}` };
    const propRes = await architect.run(120000);
    const proposal = propRes.content || propRes.result?.info?.content || "No proposal generated.";
    
    log(`[SWARM] [${task.id}] — Architect proposed ${proposal.length} chars.`);

    // 2. Reviewer Reviews
    const reviewer = new AgentRuntime({ projectPath: ws, agentType: "reviewer", task, safety, stream });
    reviewer.task = { ...task, title: `Review Proposal`, description: `Review this proposal and provide feedback or approve it:\n\n${proposal}` };
    const revRes = await reviewer.run(120000);
    const review = revRes.content || revRes.result?.info?.content || "No review generated.";
    
    log(`[SWARM] [${task.id}] — Reviewer replied ${review.length} chars.`);

    // 3. Save Consensus
    const consensus = `# Swarm Consensus\n\n## Architect Proposal\n${proposal}\n\n## Reviewer Feedback\n${review}`;
    const consensusPath = join(ws, ".hydra", "swarm-consensus.md");
    writeFileSync(consensusPath, consensus);
    
    log(`[SWARM] [${task.id}] — Consensus saved.`);
    return true;
  };

  if (mode === "parallel") {
    await Promise.all(tasksToRun.map(t => runSwarm(t)));
  } else {
    await runSwarm(tasksToRun[0]);
  }

  // Proceed to EXEC
  stream.emit("System", "system", { action: "PhaseChange", phase: "EXEC" });
}
