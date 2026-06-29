import { join, basename } from 'node:path';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { TaskManager } from '../../../src/core/task-manager.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
export async function handleDiscover(context) {
    const { tasks, projectPath, log, updateStatus, safety, stream, notion } = context;
    const { AgentRuntime } = await import('../../runtime.js');
    const tierSelector = new TierSelector();
    const tier = tierSelector.select('DISCOVER');
    updateStatus({ phase: 'DISCOVER' });
    log('[DISCOVER] Running per-project planning and codebase quality audit');
    const projectsDir = join(projectPath, 'projects');
    const projectDirs = [];
    try {
        if (existsSync(projectsDir)) {
            const entries = readdirSync(projectsDir, { withFileTypes: true });
            for (const d of entries) {
                if (d.isDirectory()) {
                    projectDirs.push(join(projectsDir, d.name));
                }
            }
        }
    }
    catch (e) {
        console.error('Ignored error:', e.message);
    }
    const prd = tasks.readPRD();
    const projectRegistry = new Map();
    for (const proj of (prd.projects || [])) {
        const slug = proj.slug || proj.title || '';
        if (slug) {
            projectRegistry.set(slug, {
                slug,
                title: proj.title || slug,
                dir: join(projectPath, 'projects', slug),
                description: proj.description || '',
                completed: proj.completed || false,
            });
        }
    }
    const discoveryTargets = [
        ...new Set([
            ...projectDirs,
            ...[...projectRegistry.values()].map((p) => p.dir),
        ]),
    ];
    if (discoveryTargets.length === 0) {
        log('[DISCOVER] No project dirs to scan. Running global discovery.');
        discoveryTargets.push(projectPath);
    }
    for (const dir of discoveryTargets) {
        const name = basename(dir);
        const projRegistryEntry = projectRegistry.get(name);
        if (projRegistryEntry?.completed) {
            log(`[DISCOVER] Project ${name} is marked as fully completed, skipping.`);
            continue;
        }
        if (!existsSync(dir)) {
            log(`[DISCOVER] Initializing project folder for ${name}`);
            try {
                mkdirSync(dir, { recursive: true });
                const ideasPath = join(dir, 'ideas.md');
                const ideasContent = `# ${projRegistryEntry?.title || name}\n\n${projRegistryEntry?.description || 'Nuova idea di progetto da pianificare e implementare.'}\n`;
                writeFileSync(ideasPath, ideasContent, 'utf-8');
            }
            catch (err) {
                log(`[DISCOVER] Failed to initialize project folder for ${name}: ${err.message}`);
                continue;
            }
        }
        const localTasks = new TaskManager({ projectPath: dir });
        let storyCount = 0;
        try {
            const projPrd = localTasks.readPRD();
            storyCount = (projPrd.stories || []).length;
        }
        catch (_) {
            // Ignored
        }
        const hasCode = (() => {
            let found = false;
            const exts = ['.js', '.ts', '.py', '.go', '.rs', '.tsx', '.jsx', '.css', '.html'];
            const search = (curr, depth) => {
                if (found || depth > 3)
                    return;
                try {
                    const files = readdirSync(curr, { withFileTypes: true });
                    for (const f of files) {
                        if (f.isDirectory() && !['node_modules', '.git', '.hydra'].includes(f.name)) {
                            search(join(curr, f.name), depth + 1);
                        }
                        else if (f.isFile() && exts.some((e) => f.name.endsWith(e))) {
                            found = true;
                            return;
                        }
                    }
                }
                catch (_) {
                    // Ignored
                }
            };
            search(dir, 1);
            return found;
        })();
        const hasSddArtifacts = [
            'PLAN.md',
            'PRODUCT-SPEC.md',
            'TECHNICAL-SPEC.md',
            'CONSTITUTION.md',
        ].every((f) => existsSync(join(dir, f)));
        const isNewProject = storyCount <= 1 || !hasSddArtifacts;
        if (isNewProject) {
            log(`[DISCOVER] Project ${name} is new or missing SDD specifications. Running project-planner...`);
            tierSelector.applyTierConfig(tier, dir);
            const planner = new AgentRuntime({
                projectPath: dir,
                agentType: 'project-planner',
                safety,
                stream,
            });
            const planResult = await planner.run(600000);
            {
                const planContent = planResult?.content || '';
                if (planContent) {
                    const sddDir = dir;
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
                                    writeFileSync(join(sddDir, fileName), section.trimStart(), 'utf-8');
                                }
                                catch (_) { }
                            }
                        }
                    }
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
                            project: projRegistryEntry?.title || name,
                            projectSlug: name,
                            description: projRegistryEntry?.description || '',
                            codebasePatterns: codebasePatterns.slice(0, 2000),
                            stories: parsedStories,
                        };
                        writeFileSync(join(dir, 'prd.json'), JSON.stringify(localPrdData, null, 2), 'utf-8');
                        log(`[DISCOVER] Written ${parsedStories.length} stories to ${name}/prd.json`);
                    }
                }
            }
            try {
                const projPrd = localTasks.readPRD();
                const rootPrd = tasks.readPRD();
                let rootProjEntry = (rootPrd.projects || []).find((p) => p.slug === name);
                if (!rootProjEntry) {
                    rootProjEntry = {
                        slug: name,
                        title: projRegistryEntry?.title || name,
                        description: projRegistryEntry?.description || '',
                        codebasePatterns: '',
                        stories: [],
                    };
                    rootPrd.projects.push(rootProjEntry);
                }
                rootProjEntry.stories = projPrd.stories || [];
                tasks.writePRD(rootPrd);
                const storiesArr = rootProjEntry.stories;
                log(`[DISCOVER] project-planner finished. Backlog decomposed into ${storiesArr.length} stories.`);
            }
            catch (err) {
                log(`[DISCOVER] Failed to sync planned stories back to root: ${err.message}`);
            }
            stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
            return;
        }
        let allStoriesCompleted = false;
        try {
            const projPrd = localTasks.readPRD();
            const stories = (projPrd.stories || []);
            allStoriesCompleted =
                stories.length > 0 &&
                    stories.every((s) => s.passes || s.status === 'completed');
        }
        catch (_) {
            // Ignored
        }
        if (allStoriesCompleted) {
            if (!hasCode) {
                log(`[DISCOVER] All features completed for ${name}, but no source code files exist. Skipping audit.`);
                continue;
            }
            log(`[DISCOVER] All features completed for ${name}. Initiating Deep Codebase Quality & Performance Audit...`);
            tierSelector.applyTierConfig(tier, dir);
            log(`[DISCOVER] Running Bug Hunter in ${name}`);
            const bugHunter = new AgentRuntime({
                projectPath: dir,
                agentType: 'bug-hunter',
                safety,
                stream,
            });
            await bugHunter.run(300000);
            log(`[DISCOVER] Running Innovator in ${name}`);
            const innovator = new AgentRuntime({
                projectPath: dir,
                agentType: 'innovator',
                safety,
                stream,
            });
            await innovator.run(300000);
            log(`[DISCOVER] Running Orchestrator Agent in ${name}`);
            const localOrch = new AgentRuntime({
                projectPath: dir,
                agentType: 'orchestrator',
                safety,
                stream,
            });
            await localOrch.run(180000);
            let newTasksFound = false;
            try {
                const projPrd = localTasks.readPRD();
                const rootPrd = tasks.readPRD();
                const rootProjEntry = (rootPrd.projects || []).find((p) => p.slug === name);
                if (rootProjEntry) {
                    for (const s of (projPrd.stories || [])) {
                        const exists = (rootProjEntry.stories || []).find((r) => String(r.id) === String(s.id));
                        if (!exists) {
                            rootProjEntry.stories.push(s);
                            newTasksFound = true;
                        }
                    }
                    if (newTasksFound) {
                        tasks.writePRD(rootPrd);
                        log(`[DISCOVER] Audit complete. Backlog updated with new tasks/bug fixes.`);
                    }
                }
            }
            catch (err) {
                log(`[DISCOVER] Failed to sync audited stories back to root: ${err.message}`);
            }
            if (newTasksFound) {
                stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
                return;
            }
            else {
                log(`[DISCOVER] Audit passed with 0 new bugs or feature proposals.`);
                log(`[DISCOVER] Project ${name} is fully complete, runnable, and state-of-the-art!`);
                try {
                    const rootPrd = tasks.readPRD();
                    const rootProjEntry = (rootPrd.projects || []).find((p) => p.slug === name);
                    if (rootProjEntry) {
                        rootProjEntry.completed = true;
                        tasks.writePRD(rootPrd);
                    }
                }
                catch (err) {
                    log(`[DISCOVER] Failed to mark project completed: ${err.message}`);
                }
            }
        }
        else {
            let pendingCount = 0;
            let hasAnyReady = false;
            try {
                const projPrd = localTasks.readPRD();
                const sarr = (projPrd.stories || []);
                pendingCount = sarr.filter((s) => !s.passes && s.status !== 'completed').length;
                hasAnyReady = sarr.some((s) => {
                    if (s.passes || s.status === 'blocked')
                        return false;
                    const deps = s._deps ||
                        s.dependencies ||
                        s.dependsOn ||
                        [];
                    if (deps.length === 0)
                        return true;
                    return deps.every((depId) => {
                        const dep = sarr.find((d) => String(d.id) === String(depId));
                        return dep ? dep.passes : true;
                    });
                });
            }
            catch {
                // Ignored
            }
            if (pendingCount > 0 && !hasAnyReady) {
                log(`[DISCOVER] Project ${name} has ${pendingCount} pending/blocked tasks but none ready. Running orchestrator to unblock...`);
                tierSelector.applyTierConfig(tier, dir);
                const unblocker = new AgentRuntime({
                    projectPath: dir,
                    agentType: 'orchestrator',
                    safety,
                    stream,
                });
                await unblocker.run(180000);
            }
            else {
                log(`[DISCOVER] Project ${name} has pending tasks, skipping discovery to let IDLE process them.`);
            }
        }
    }
    await tasks.loadTasks();
    if (notion &&
        typeof notion.isReady === 'function' &&
        notion.isReady()) {
        try {
            const currentPrd = tasks.readPRD();
            const allStories = [];
            for (const proj of (currentPrd.projects || [])) {
                for (const s of (proj.stories || []))
                    allStories.push(s);
            }
            for (const s of (currentPrd.crossProjectStories || []))
                allStories.push(s);
            for (const s of allStories) {
                if (s.passes || s.pageId)
                    continue;
                const pageId = await notion
                    .createStory({
                    storyId: s.id,
                    title: s.title,
                    description: s.description,
                    acceptanceCriteria: s.acceptanceCriteria || [],
                    priority: s.priority,
                    tag: s.tag,
                    status: 'idle',
                })
                    .catch(() => null);
                if (pageId) {
                    s.pageId = pageId;
                    tasks._persist();
                    tasks.rebuildProjectFiles();
                }
            }
        }
        catch (e) {
            log(`[DISCOVER] Notion sync error: ${e.message}`);
        }
    }
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
}
