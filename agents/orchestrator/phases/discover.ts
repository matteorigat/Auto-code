import { join, basename } from 'node:path';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { OrchestratorContext } from '../types.js';

export async function handleDiscover(context: OrchestratorContext): Promise<void> {
  const { tasks, projectPath, log, updateStatus, stream, notion, state } = context;

  updateStatus({ phase: 'DISCOVER', taskTitle: 'Scanning projects and workspaces...' });
  log('[DISCOVER] Running project discovery and workspace initialization');

  const projectsDir = join(projectPath, 'projects');
  const projectDirs: string[] = [];
  try {
    if (existsSync(projectsDir)) {
      const entries = readdirSync(projectsDir, { withFileTypes: true });
      for (const d of entries) {
        if (d.isDirectory()) {
          projectDirs.push(join(projectsDir, d.name));
        }
      }
    }
  } catch (e: unknown) {
    console.error('Ignored error:', (e as Error).message);
  }

  const prd = tasks.readPRD() as unknown as Record<string, unknown[]>;
  const projectRegistry = new Map<string, Record<string, unknown>>();
  for (const proj of (prd.projects || []) as Record<string, unknown>[]) {
    const slug = (proj.slug as string) || (proj.title as string) || '';
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

  const discoveryTargets: string[] = [
    ...new Set([
      ...projectDirs,
      ...[...projectRegistry.values()].map((p: Record<string, unknown>) => p.dir as string),
    ]),
  ];

  if (discoveryTargets.length === 0) {
    log('[DISCOVER] No project dirs to scan. Running global discovery.');
    discoveryTargets.push(projectPath);
  }

  for (const dir of discoveryTargets) {
    const name = basename(dir);
    updateStatus({ phase: 'DISCOVER', taskTitle: `Checking project: ${name}...`, project: name });

    const projRegistryEntry = projectRegistry.get(name) as Record<string, unknown> | undefined;
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
        const ideasContent = `# ${(projRegistryEntry?.title as string) || name}\n\n${(projRegistryEntry?.description as string) || 'Nuova idea di progetto da pianificare e implementare.'}\n`;
        writeFileSync(ideasPath, ideasContent, 'utf-8');
      } catch (err: unknown) {
        log(
          `[DISCOVER] Failed to initialize project folder for ${name}: ${(err as Error).message}`,
        );
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
      } catch (err: unknown) {
        log(`[DISCOVER] Failed to initialize git in ${dir}: ${(err as Error).message}`);
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
      } catch (err: unknown) {
        log(`[DISCOVER] Failed to create .gitignore in ${dir}: ${(err as Error).message}`);
      }
    }
  }

  updateStatus({ phase: 'DISCOVER', taskTitle: 'Reloading tasks...' });
  await tasks.loadTasks();

  if (
    notion &&
    typeof (notion as unknown as Record<string, unknown>).isReady === 'function' &&
    (notion as unknown as Record<string, () => boolean>).isReady()
  ) {
    updateStatus({ phase: 'DISCOVER', taskTitle: 'Syncing local tasks to Notion database...' });
    try {
      const currentPrd = tasks.readPRD() as unknown as Record<string, Record<string, unknown>[]>;
      const allStories: Record<string, unknown>[] = [];
      for (const proj of (currentPrd.projects || []) as Record<string, unknown>[]) {
        for (const s of (proj.stories || []) as Record<string, unknown>[]) allStories.push(s);
      }
      for (const s of (currentPrd.crossProjectStories || []) as Record<string, unknown>[])
        allStories.push(s);

      for (const s of allStories) {
        if (s.passes || s.pageId) continue;
        const pageId = await (
          notion as unknown as Record<
            string,
            (opts: Record<string, unknown>) => Promise<string | null>
          >
        )
          .createStory({
            storyId: s.id,
            title: s.title,
            description: s.description,
            acceptanceCriteria: (s.acceptanceCriteria as string[]) || [],
            priority: s.priority,
            tag: s.tag,
            status: 'idle',
          })
          .catch(() => null);
        if (pageId) {
          s.pageId = pageId;
          (tasks as unknown as Record<string, () => void>)._persist();
          (tasks as unknown as Record<string, () => void>).rebuildProjectFiles();
        }
      }
    } catch (e: unknown) {
      log(`[DISCOVER] Notion sync error: ${(e as Error).message}`);
    }
  }

  updateStatus({ phase: 'DISCOVER', taskTitle: 'Finishing discovery phase...' });
  state.set('discoverCount', 0);
  stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
}
