import { AgentRuntime, type RunResult } from '../../runtime.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { TierSelector } from '../../../src/core/tier-selector.js';
import type { OrchestratorContext } from '../types.js';

export async function handleSwarm(context: OrchestratorContext): Promise<void> {
  const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;

  log(`[SWARM] Running SWARM phase...`);
  const currentState = state.get() || ({} as Record<string, unknown>);
  const execTaskIds = ((currentState as Record<string, unknown[]>).execTaskIds || []) as string[];
  const tasksArr = (tasks as unknown as Record<string, Record<string, unknown>[]>)._tasks || [];

  if (!execTaskIds.length) {
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
    return;
  }

  const tasksToRun = execTaskIds
    .map((id: string) => tasksArr.find((t: Record<string, unknown>) => String(t.id) === String(id)))
    .filter(Boolean) as Record<string, unknown>[];
  const mode = tasks.getExecutionMode();

  log(
    `[SWARM] Swarming for tasks: ${tasksToRun.map((t: Record<string, unknown>) => t.id).join(', ')} (${mode})`,
  );

  const runSwarm = async (task: Record<string, unknown>): Promise<boolean> => {
    const ws = (task.workspacePath as string) || projectPath;
    updateStatus({ phase: 'SWARM', taskTitle: task.title, taskId: task.id });

    log(`[SWARM] [${task.id}] — Architect vs Reviewer Negotiation`);

    const tierSelector = new TierSelector();
    const tier = tierSelector.select('SWARM');
    tierSelector.applyTierConfig(tier, ws);
    const architect = new AgentRuntime({
      projectPath: ws,
      agentType: 'architect',
      task,
      safety,
      stream,
    });
    architect.task = { ...task, title: `Architecture Proposal: ${task.title}` };
    const propRes: RunResult = await architect.run(120000);
    const proposal =
      propRes.content ||
      (propRes.result as { info?: { content?: string } } | undefined)?.info?.content ||
      'No proposal generated.';

    log(`[SWARM] [${task.id}] — Architect proposed ${proposal.length} chars.`);

    const reviewer = new AgentRuntime({
      projectPath: ws,
      agentType: 'reviewer',
      task,
      safety,
      stream,
    });
    reviewer.task = {
      ...task,
      title: `Review Proposal`,
      description: `Review this proposal and provide feedback or approve it:\n\n${proposal}`,
    };
    const revRes: RunResult = await reviewer.run(120000);
    const review =
      revRes.content ||
      (revRes.result as { info?: { content?: string } } | undefined)?.info?.content ||
      'No review generated.';

    log(`[SWARM] [${task.id}] — Reviewer replied ${review.length} chars.`);

    const consensus = `# Swarm Consensus\n\n## Architect Proposal\n${proposal}\n\n## Reviewer Feedback\n${review}`;
    const consensusPath = join(ws, '.hydra', 'swarm-consensus.md');
    writeFileSync(consensusPath, consensus);

    log(`[SWARM] [${task.id}] — Consensus saved.`);
    return true;
  };

  if (mode === 'parallel') {
    await Promise.all(tasksToRun.map((t: Record<string, unknown>) => runSwarm(t)));
  } else {
    await runSwarm(tasksToRun[0]);
  }

  stream.emit('System', 'system', { action: 'PhaseChange', phase: 'EXEC' });
}
