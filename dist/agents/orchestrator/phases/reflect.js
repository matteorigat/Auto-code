import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TierSelector } from '../../../src/core/tier-selector.js';
export async function handleReflect(context) {
    const { tasks, state, projectPath, log, updateStatus, safety, stream } = context;
    const { AgentRuntime } = await import('../../runtime.js');
    const taskId = state.get()?.currentTaskId;
    const tasksArray = tasks._tasks;
    const task = tasksArray?.find((t) => String(t.id) === String(taskId));
    const ws = task?.workspacePath || projectPath;
    updateStatus({ phase: 'REFLECT', taskTitle: `[${taskId}] Preparing retrospective analysis...`, taskId });
    log('[REFLECT] extracting reusable skills');
    try {
        updateStatus({ phase: 'REFLECT', taskTitle: `[${taskId}] Extracting git changes diff...`, taskId });
        const diff = execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], {
            cwd: ws,
            timeout: 10000,
        }).toString();
        if (!diff.trim()) {
            log('[REFLECT] no diff found, skipping');
        }
        else {
            updateStatus({ phase: 'REFLECT', taskTitle: `[${taskId}] Mining reusable skills with skill-extractor...`, taskId });
            const tierSelector = new TierSelector();
            const tier = tierSelector.select('REFLECT');
            tierSelector.applyTierConfig(tier, projectPath);
            const agent = new AgentRuntime({ projectPath, agentType: 'skill-extractor', safety, stream });
            const currentStory = state.get()?.currentStory;
            agent.task = { title: currentStory, description: diff };
            const result = await agent.run(120000);
            if (result.ok &&
                (result.content ||
                    result.result?.info?.content)) {
                const skillContent = result.content ||
                    result.result?.info?.content ||
                    '';
                if (!skillContent.includes('NO_SKILL') && skillContent.length > 50) {
                    const skillsDir = join(projectPath, '.hydra', 'skills');
                    if (!existsSync(skillsDir))
                        mkdirSync(skillsDir, { recursive: true });
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
                }
                else {
                    log('[REFLECT] task deemed trivial, no skill extracted');
                }
            }
        }
    }
    catch (err) {
        log(`[REFLECT] error (non-fatal): ${err.message}`);
    }
    if (task && task._projectSlug) {
        updateStatus({ phase: 'REFLECT', taskTitle: `Checking completion status for ${task._projectSlug}...`, taskId });
        try {
            const rootPrd = tasks.readPRD();
            const projectEntry = (rootPrd.projects || []).find((p) => p.slug === task._projectSlug);
            if (projectEntry) {
                const stories = (projectEntry.stories || []);
                const allStoriesCompleted = stories.length > 0 &&
                    stories.every((s) => s.passes || s.status === 'completed');
                if (allStoriesCompleted) {
                    log(`[REFLECT] All stories completed for project ${task._projectSlug}.`);
                    log(`[REFLECT] The project is already state-of-the-art in every part and no new feature can be implemented.`);
                    log(`[REFLECT] Transitioning to COMPLETED state and exiting loop.`);
                    projectEntry.completed = true;
                    tasks.writePRD(rootPrd);
                    stream.emit('System', 'system', {
                        action: 'PhaseChange',
                        phase: 'DONE',
                        stateUpdates: { currentTaskId: null, currentStory: null },
                    });
                    setTimeout(() => process.exit(0), 1000);
                    return;
                }
            }
        }
        catch (err) {
            log(`[REFLECT] Error verifying project completion status: ${err.message}`);
        }
    }
    stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'SYNC',
    });
}
