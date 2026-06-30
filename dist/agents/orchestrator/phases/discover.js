import { join, basename } from 'node:path';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
export async function handleDiscover(context) {
    const { tasks, projectPath, log, updateStatus, stream, notion, state } = context;
    updateStatus({ phase: 'DISCOVER', taskTitle: 'Scanning projects and workspaces...' });
    log('[DISCOVER] Running project discovery and workspace initialization');
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
        updateStatus({ phase: 'DISCOVER', taskTitle: `Checking project: ${name}...`, project: name });
        const projRegistryEntry = projectRegistry.get(name);
        if (projRegistryEntry?.completed) {
            log(`[DISCOVER] Project ${name} is marked as fully completed, skipping.`);
            continue;
        }
        if (!existsSync(dir)) {
            updateStatus({ phase: 'DISCOVER', taskTitle: `Setting up directory for ${name}...`, project: name });
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
        // Ensure Git is initialized
        const gitDir = join(dir, '.git');
        if (!existsSync(gitDir)) {
            updateStatus({ phase: 'DISCOVER', taskTitle: `Initializing Git repository for ${name}...`, project: name });
            log(`[DISCOVER] Initializing git repository in ${dir}`);
            try {
                execSync('git init', { cwd: dir, stdio: 'ignore' });
            }
            catch (err) {
                log(`[DISCOVER] Failed to initialize git in ${dir}: ${err.message}`);
            }
        }
        // Ensure .gitignore is present
        const gitignorePath = join(dir, '.gitignore');
        if (!existsSync(gitignorePath)) {
            updateStatus({ phase: 'DISCOVER', taskTitle: `Creating .gitignore for ${name}...`, project: name });
            log(`[DISCOVER] Creating .gitignore in ${dir}`);
            try {
                const gitignoreContent = `node_modules/
.env
.DS_Store
dist/
build/
.hydra/
`;
                writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
            }
            catch (err) {
                log(`[DISCOVER] Failed to create .gitignore in ${dir}: ${err.message}`);
            }
        }
    }
    updateStatus({ phase: 'DISCOVER', taskTitle: 'Reloading tasks...' });
    await tasks.loadTasks();
    if (notion &&
        typeof notion.isReady === 'function' &&
        notion.isReady()) {
        updateStatus({ phase: 'DISCOVER', taskTitle: 'Syncing local tasks to Notion database...' });
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
    updateStatus({ phase: 'DISCOVER', taskTitle: 'Finishing discovery phase...' });
    state.set('discoverCount', 0);
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
}
