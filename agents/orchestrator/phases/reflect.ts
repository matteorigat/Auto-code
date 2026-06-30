import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
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
  const currentStory = state.get()?.currentStory as string | undefined;

  updateStatus({ phase: 'REFLECT', taskTitle: `[${taskId}] Preparing retrospective analysis...`, taskId });
  log('[REFLECT] extracting reusable skills');

  try {
    updateStatus({ phase: 'REFLECT', taskTitle: `[${taskId}] Extracting git changes diff...`, taskId });
    const diff = execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], {
      cwd: ws,
      timeout: 10000,
    }).toString();
    if (!diff.trim()) {
      log('[REFLECT] no diff found, skipping skill extraction');
    } else {
      updateStatus({ phase: 'REFLECT', taskTitle: `[${taskId}] Mining reusable skills with skill-extractor...`, taskId });
      const tierSelector = new TierSelector();
      const tier = tierSelector.select('REFLECT');
      tierSelector.applyTierConfig(tier, projectPath);

      const agent = new AgentRuntime({ projectPath, agentType: 'skill-extractor', safety, stream });
      // F4: Pass meaningful task title (not "Fix QA Error") so skill-extractor has context
      agent.task = {
        title: currentStory || `Task ${taskId}`,
        description: `Analyze this git diff and extract reusable engineering patterns:\n\n${diff.slice(0, 8000)}`,
      };

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
          const skillsDir = join(ws, '.hydra', 'skills');
          if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });

          // F4: Fix regex — was /^#\\s+(.+)$/m (wrong double backslash), now correctly /^#\s+(.+)$/m
          const titleMatch = skillContent.match(/SKILL_TITLE:\s*(.+)/) ||
            skillContent.match(/^#\s+(.+)$/m);
          let safeTitle = taskId || 'unknown';
          let skillTitle = '';
          if (titleMatch) {
            skillTitle = titleMatch[1].trim();
            safeTitle = skillTitle
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .slice(0, 40);
          }
          const filename = `skill-${safeTitle}-${Date.now().toString(36)}.md`;
          const skillFilePath = join(skillsDir, filename);

          writeFileSync(skillFilePath, skillContent, 'utf-8');
          log(`[REFLECT] Skill saved to ${filename}`);

          // F4: Append skill to AGENTS.md so the builder reads it in future runs
          const agentsMdPath = join(ws, 'AGENTS.md');
          try {
            const skillSummary = skillContent.slice(0, 800);
            const agentsEntry = `\n\n---\n\n## Extracted Skill: ${skillTitle || safeTitle}\n*Extracted after task: ${currentStory || taskId}*\n\n${skillSummary}`;
            if (existsSync(agentsMdPath)) {
              appendFileSync(agentsMdPath, agentsEntry, 'utf-8');
            } else {
              writeFileSync(agentsMdPath, `# AGENTS.md — Project Patterns & Skills\n${agentsEntry}`, 'utf-8');
            }
            log(`[REFLECT] Appended skill to AGENTS.md`);
          } catch (appendErr: unknown) {
            log(`[REFLECT] Failed to append skill to AGENTS.md: ${(appendErr as Error).message}`);
          }
        } else {
          log('[REFLECT] task deemed trivial, no skill extracted');
        }
      }
    }
  } catch (err: unknown) {
    log(`[REFLECT] error (non-fatal): ${(err as Error).message}`);
  }

  if (task && task._projectSlug) {
    updateStatus({ phase: 'REFLECT', taskTitle: `Checking completion status for ${task._projectSlug}...`, taskId });
    try {
      const rootPrd = tasks.readPRD() as unknown as Record<string, Record<string, unknown>[]>;
      const projectEntry = ((rootPrd.projects || []) as Record<string, unknown>[]).find(
        (p: Record<string, unknown>) => p.slug === task._projectSlug,
      );
      if (projectEntry) {
        const stories = (projectEntry.stories || []) as Record<string, unknown>[];
        const allStoriesCompleted =
          stories.length > 0 &&
          stories.every((s: Record<string, unknown>) => s.passes || s.status === 'completed');

        if (allStoriesCompleted) {
          log(`[REFLECT] All stories completed for project ${task._projectSlug}.`);
          log(`[REFLECT] The project is already state-of-the-art in every part and no new feature can be implemented.`);
          log(`[REFLECT] Transitioning to COMPLETED state and exiting loop.`);

          projectEntry.completed = true;
          tasks.writePRD(rootPrd as any);

          stream.emit('System', 'system', {
            action: 'PhaseChange',
            phase: 'DONE',
            stateUpdates: { currentTaskId: null, currentStory: null },
          });

          setTimeout(() => process.exit(0), 1000);
          return;
        }
      }
    } catch (err: unknown) {
      log(`[REFLECT] Error verifying project completion status: ${(err as Error).message}`);
    }
  }

  stream.emit('System', 'system', {
    action: 'PhaseChange',
    phase: 'SYNC',
  });
}
