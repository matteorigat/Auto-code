import { basename, join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { TaskManager } from '../../../src/core/task-manager.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
import { AgentRuntime } from '../../runtime.js';
export async function handlePlan(context) {
    const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;
    log(`[PLAN] Running PLAN phase...`);
    const currentState = state.get() || {};
    const readyTaskIds = currentState.readyTaskIds || [];
    if (!readyTaskIds.length) {
        log(`[PLAN] No tasks to plan. Back to IDLE.`);
        stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
        return;
    }
    const tasksToExec = [];
    const tasksArr = tasks._tasks || [];
    for (const taskId of readyTaskIds) {
        const task = tasksArr.find((t) => String(t.id) === String(taskId));
        if (!task)
            continue;
        updateStatus({ phase: 'PLAN', taskTitle: task.title, taskId: task.id });
        if (tasks.needsSplitting(task)) {
            log(`[PLAN] Story ${task.id} too large — splitting`);
            const parts = tasks.splitStory(task);
            const newTasks = tasksArr.filter((t) => String(t.id) !== String(task.id));
            tasks._tasks = newTasks;
            for (const p of parts)
                tasks.addStory(p);
            stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
            return;
        }
        const projectDir = _resolveProjectDir(task, projectPath);
        task.workspacePath = projectDir;
        task._projectSlug = basename(projectDir);
        // Project-level planning check
        const sddArtifacts = ['PLAN.md', 'PRODUCT-SPEC.md', 'TECHNICAL-SPEC.md', 'CONSTITUTION.md'];
        const hasSddArtifacts = sddArtifacts.every((f) => existsSync(join(projectDir, f)));
        const localTasks = new TaskManager({ projectPath: projectDir });
        let storyCount = 0;
        try {
            const projPrd = localTasks.readPRD();
            storyCount = (projPrd.stories || []).length;
        }
        catch (_) { }
        const isNewProject = storyCount <= 1 || !hasSddArtifacts;
        if (isNewProject) {
            updateStatus({ phase: 'PLAN', taskTitle: `[${task._projectSlug}] Decomposing project with project-planner...`, taskId: task.id });
            log(`[PLAN] Project ${task._projectSlug} is new or missing SDD specifications. Running project-planner...`);
            const tierSelector = new TierSelector();
            const tier = tierSelector.select('PLAN');
            tierSelector.applyTierConfig(tier, projectDir);
            const planner = new AgentRuntime({
                projectPath: projectDir,
                agentType: 'project-planner',
                safety,
                stream,
            });
            const planResult = await planner.run(600000);
            const planContent = planResult?.content || '';
            if (planContent) {
                updateStatus({ phase: 'PLAN', taskTitle: `[${task._projectSlug}] Writing SDD specification files (PLAN.md, PRODUCT-SPEC.md, ...)...`, taskId: task.id });
                const sections = planContent.split(/(?=^## )/m);
                for (const section of sections) {
                    const header = section.match(/^## (.+)$/m);
                    if (header) {
                        const title = header[1].trim();
                        let fileName = '';
                        const lower = title.toLowerCase();
                        if (lower.includes('constitution'))
                            fileName = 'CONSTITUTION.md';
                        else if (lower.includes('product') || lower.includes('functional'))
                            fileName = 'PRODUCT-SPEC.md';
                        else if (lower.includes('technical'))
                            fileName = 'TECHNICAL-SPEC.md';
                        else if (lower.includes('plan') || lower.includes('implement'))
                            fileName = 'PLAN.md';
                        if (fileName) {
                            try {
                                writeFileSync(join(projectDir, fileName), section.trimStart(), 'utf-8');
                            }
                            catch (_) { }
                        }
                    }
                }
                updateStatus({ phase: 'PLAN', taskTitle: `[${task._projectSlug}] Decomposing tasks and saving backlog to prd.json...`, taskId: task.id });
                const storyLines = planContent.match(/^\d+\.\s+.+/gm) || [];
                const parsedStories = [];
                for (const line of storyLines) {
                    const title = line.replace(/^\d+\.\s+/, '').trim();
                    if (title) {
                        parsedStories.push({
                            id: `US-${Date.now().toString(36)}-${parsedStories.length + 1}`,
                            title,
                            description: '',
                            acceptanceCriteria: [],
                            priority: 3,
                            status: 'idle',
                            passes: false,
                        });
                    }
                }
                if (parsedStories.length > 0) {
                    const codebasePatterns = planContent.match(/## Technical[\s\S]*?(?=## |$)/)?.[0] || '';
                    const localPrdData = {
                        project: task.title,
                        projectSlug: task._projectSlug,
                        description: task.description || '',
                        codebasePatterns: codebasePatterns.slice(0, 2000),
                        stories: parsedStories,
                    };
                    writeFileSync(join(projectDir, 'prd.json'), JSON.stringify(localPrdData, null, 2), 'utf-8');
                    log(`[PLAN] Written ${parsedStories.length} stories to ${task._projectSlug}/prd.json`);
                }
            }
            // Sync stories back to root prd.json
            updateStatus({ phase: 'PLAN', taskTitle: `[${task._projectSlug}] Syncing project stories to root backlog...`, taskId: task.id });
            try {
                const projPrd = localTasks.readPRD();
                const rootPrd = tasks.readPRD();
                let rootProjEntry = (rootPrd.projects || []).find((p) => p.slug === task._projectSlug);
                if (!rootProjEntry) {
                    rootProjEntry = {
                        slug: task._projectSlug,
                        title: task.title,
                        description: task.description || '',
                        codebasePatterns: '',
                        stories: [],
                    };
                    rootPrd.projects.push(rootProjEntry);
                }
                rootProjEntry.stories = projPrd.stories || [];
                tasks.writePRD(rootPrd);
                log(`[PLAN] project-planner finished. Backlog decomposed into ${projPrd.stories?.length || 0} stories.`);
            }
            catch (err) {
                log(`[PLAN] Failed to sync planned stories back to root: ${err.message}`);
            }
            // Mark the project-level task as completed!
            tasks.markPass(task.id);
            stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
            return;
        }
        log(`[PLAN] Planning task: ${task.id} ${task.title}`);
        tasks._syncProjectFiles(task);
        const tierSelector = new TierSelector();
        const tier = tierSelector.select('PLAN');
        tierSelector.applyTierConfig(tier, projectDir);
        updateStatus({ phase: 'PLAN', taskTitle: `[${task.id}] Generating tests and requirements with task-planner...`, taskId: task.id });
        log(`[PLAN] [${task.id}] Running task-planner to generate tests and details`);
        const taskPlanner = new AgentRuntime({
            projectPath: projectDir,
            agentType: 'task-planner',
            task,
            safety,
            stream,
            tasks: localTasks,
        });
        await taskPlanner.run(300000);
        updateStatus({ phase: 'PLAN', taskTitle: `[${task.id}] Architecting technical changes with architect...`, taskId: task.id });
        log(`[PLAN] [${task.id}] Running architect to generate technical proposal`);
        const architect = new AgentRuntime({
            projectPath: projectDir,
            agentType: 'architect',
            task,
            safety,
            stream,
            tasks: localTasks,
        });
        await architect.run(300000);
        updateStatus({ phase: 'PLAN', taskTitle: `[${task.id}] Reviewing technical plan with reviewer...`, taskId: task.id });
        log(`[PLAN] [${task.id}] Running reviewer to review technical proposal`);
        const reviewer = new AgentRuntime({
            projectPath: projectDir,
            agentType: 'reviewer',
            task,
            safety,
            stream,
            tasks: localTasks,
        });
        await reviewer.run(300000);
        tasksToExec.push(task.id);
    }
    stream.emit('System', 'system', {
        action: 'PhaseChange',
        phase: 'CODE',
        stateUpdates: { execTaskIds: tasksToExec },
    });
}
function _resolveProjectDir(story, projectPath) {
    if (story.workspacePath && existsSync(story.workspacePath))
        return story.workspacePath;
    if (story._projectSlug)
        return join(projectPath, 'projects', story._projectSlug);
    return projectPath;
}
