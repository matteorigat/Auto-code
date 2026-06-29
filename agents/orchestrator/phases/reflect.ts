import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TierSelector } from '../../../src/core/tier-selector.js';
import type { OrchestratorContext } from '../types.js';

export async function handleReflect(context: OrchestratorContext): Promise<void> {
  const { tasks, state, projectPath, log, updateStatus, safety, stream } = context;
  const { AgentRuntime } = await import('../../runtime.js');

  const taskId = state.get()?.currentTaskId;
  const tasksArray = (tasks as unknown as Record<string, unknown[]>)._tasks as Record<
    string,
    unknown
  >[];
  const task = tasksArray?.find((t: Record<string, unknown>) => String(t.id) === String(taskId));
  const ws = (task?.workspacePath as string) || projectPath;

  updateStatus({ phase: 'REFLECT', taskTitle: state.get()?.currentStory, taskId });
  log('[REFLECT] extracting reusable skills');

  try {
    const diff = execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], {
      cwd: ws,
      timeout: 10000,
    }).toString();
    if (!diff.trim()) {
      log('[REFLECT] no diff found, skipping');
    } else {
      const tierSelector = new TierSelector();
      const tier = tierSelector.select('REFLECT');
      tierSelector.applyTierConfig(tier, projectPath);

      const agent = new AgentRuntime({ projectPath, agentType: 'skill-extractor', safety, stream });
      const currentStory = state.get()?.currentStory as string | undefined;
      agent.task = { title: currentStory, description: diff };

      const result = await agent.run(120000);
      if (
        result.ok &&
        (result.content ||
          (result.result as { info?: { content?: string } } | undefined)?.info?.content)
      ) {
        const skillContent =
          result.content ||
          (result.result as { info?: { content?: string } } | undefined)?.info?.content ||
          '';
        if (!skillContent.includes('NO_SKILL') && skillContent.length > 50) {
          const skillsDir = join(projectPath, '.hydra', 'skills');
          if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });

          const titleMatch = skillContent.match(/^#\\s+(.+)$/m);
          let safeTitle = taskId || 'unknown';
          if (titleMatch) {
            safeTitle = titleMatch[1]
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .slice(0, 40);
          }
          const filename = `skill-${safeTitle}-${Date.now().toString(36)}.md`;

          writeFileSync(join(skillsDir, filename), skillContent, 'utf-8');
          log(`[REFLECT] extracted skill saved to ${filename}`);
        } else {
          log('[REFLECT] task deemed trivial, no skill extracted');
        }
      }
    }
  } catch (err: unknown) {
    log(`[REFLECT] error (non-fatal): ${(err as Error).message}`);
  }

  stream.emit('System', 'system', {
    action: 'PhaseChange',
    phase: 'SYNC',
  });
}
