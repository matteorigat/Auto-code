import { join, basename } from 'node:path';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { TaskManager } from '../../../src/core/task-manager.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
import type { OrchestratorContext } from '../types.js';

export async function handleDiscover(context: OrchestratorContext): Promise<void> {
  const { tasks, projectPath, log, updateStatus, safety, stream, notion } = context;
  const { AgentRuntime } = await import('../../runtime.js');

  const tierSelector = new TierSelector();
  const tier = tierSelector.select('DISCOVER');

  updateStatus({ phase: 'DISCOVER' });
  log('[DISCOVER] Running per-project planning and codebase quality audit');

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

    const projRegistryEntry = projectRegistry.get(name) as Record<string, unknown> | undefined;
    if (projRegistryEntry?.completed) {
      log(`[DISCOVER] Project ${name} is marked as fully completed, skipping.`);
      continue;
    }

    if (!existsSync(dir)) {
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

    const localTasks = new TaskManager({ projectPath: dir });
    let storyCount = 0;
    try {
      const projPrd = localTasks.readPRD() as unknown as Record<string, unknown[]>;
      storyCount = ((projPrd.stories || []) as unknown[]).length;
    } catch (_) {
      // Ignored
    }

    const hasCode = (() => {
      let found = false;
      const exts = ['.js', '.ts', '.py', '.go', '.rs', '.tsx', '.jsx', '.css', '.html'];
      const search = (curr: string, depth: number): void => {
        if (found || depth > 3) return;
        try {
          const files = readdirSync(curr, { withFileTypes: true });
          for (const f of files) {
            if (f.isDirectory() && !['node_modules', '.git', '.hydra'].includes(f.name)) {
              search(join(curr, f.name), depth + 1);
            } else if (f.isFile() && exts.some((e: string) => f.name.endsWith(e))) {
              found = true;
              return;
            }
          }
        } catch (_) {
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
    ].every((f: string) => existsSync(join(dir, f)));

    const isNewProject = storyCount <= 1 || !hasSddArtifacts;

    if (isNewProject) {
      log(
        `[DISCOVER] Project ${name} is new or missing SDD specifications. Running project-planner...`,
      );
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
              if (lower.includes('constitution')) fileName = 'CONSTITUTION.md';
              else if (lower.includes('product') || lower.includes('functional')) fileName = 'PRODUCT-SPEC.md';
              else if (lower.includes('technical')) fileName = 'TECHNICAL-SPEC.md';
              else if (lower.includes('plan') || lower.includes('implement')) fileName = 'PLAN.md';
              if (fileName) {
                try {
                  writeFileSync(join(sddDir, fileName), section.trimStart(), 'utf-8');
                } catch (_) {}

              }
            }
          }
          const storyLines = planContent.match(/^\d+\.\s+.+/gm) || [];
          const parsedStories: Record<string, unknown>[] = [];
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
              project: (projRegistryEntry?.title as string) || name,
              projectSlug: name,
              description: (projRegistryEntry?.description as string) || '',
              codebasePatterns: codebasePatterns.slice(0, 2000),
              stories: parsedStories,
            };
            writeFileSync(join(dir, 'prd.json'), JSON.stringify(localPrdData, null, 2), 'utf-8');
            log(`[DISCOVER] Written ${parsedStories.length} stories to ${name}/prd.json`);
          }
        }
      }

      try {
        const projPrd = localTasks.readPRD() as unknown as Record<
          string,
          Record<string, unknown>[]
        >;
        const rootPrd = tasks.readPRD() as unknown as Record<string, Record<string, unknown>[]>;
        let rootProjEntry = ((rootPrd.projects || []) as Record<string, unknown>[]).find(
          (p: Record<string, unknown>) => p.slug === name,
        ) as Record<string, unknown> | undefined;
        if (!rootProjEntry) {
          rootProjEntry = {
            slug: name,
            title: (projRegistryEntry?.title as string) || name,
            description: (projRegistryEntry?.description as string) || '',
            codebasePatterns: '',
            stories: [],
          };
          (rootPrd.projects as Record<string, unknown>[]).push(rootProjEntry);
        }
        rootProjEntry.stories = projPrd.stories || [];
        tasks.writePRD(rootPrd as unknown as import('../../../src/core/task-manager.js').PRD);
        const storiesArr = rootProjEntry.stories as unknown[];
        log(
          `[DISCOVER] project-planner finished. Backlog decomposed into ${storiesArr.length} stories.`,
        );
      } catch (err: unknown) {
        log(`[DISCOVER] Failed to sync planned stories back to root: ${(err as Error).message}`);
      }

      stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
      return;
    }

    let allStoriesCompleted = false;
    try {
      const projPrd = localTasks.readPRD() as unknown as Record<string, Record<string, unknown>[]>;
      const stories = (projPrd.stories || []) as Record<string, unknown>[];
      allStoriesCompleted =
        stories.length > 0 &&
        stories.every((s: Record<string, unknown>) => s.passes || s.status === 'completed');
    } catch (_) {
      // Ignored
    }

    if (allStoriesCompleted) {
      if (!hasCode) {
        log(
          `[DISCOVER] All features completed for ${name}, but no source code files exist. Skipping audit.`,
        );
        continue;
      }
      log(
        `[DISCOVER] All features completed for ${name}. Initiating Deep Codebase Quality & Performance Audit...`,
      );
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
        const projPrd = localTasks.readPRD() as unknown as Record<
          string,
          Record<string, unknown>[]
        >;
        const rootPrd = tasks.readPRD() as unknown as Record<string, Record<string, unknown>[]>;
        const rootProjEntry = ((rootPrd.projects || []) as Record<string, unknown>[]).find(
          (p: Record<string, unknown>) => p.slug === name,
        ) as Record<string, unknown> | undefined;
        if (rootProjEntry) {
          for (const s of (projPrd.stories || []) as Record<string, unknown>[]) {
            const exists = ((rootProjEntry.stories || []) as Record<string, unknown>[]).find(
              (r: Record<string, unknown>) => String(r.id) === String(s.id),
            );
            if (!exists) {
              (rootProjEntry.stories as Record<string, unknown>[]).push(s);
              newTasksFound = true;
            }
          }
          if (newTasksFound) {
            tasks.writePRD(rootPrd as unknown as import('../../../src/core/task-manager.js').PRD);
            log(`[DISCOVER] Audit complete. Backlog updated with new tasks/bug fixes.`);
          }
        }
      } catch (err: unknown) {
        log(`[DISCOVER] Failed to sync audited stories back to root: ${(err as Error).message}`);
      }

      if (newTasksFound) {
        stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
        return;
      } else {
        log(`[DISCOVER] Audit passed with 0 new bugs or feature proposals.`);
        log(`[DISCOVER] Project ${name} is fully complete, runnable, and state-of-the-art!`);

        try {
          const rootPrd = tasks.readPRD() as unknown as Record<string, Record<string, unknown>[]>;
          const rootProjEntry = ((rootPrd.projects || []) as Record<string, unknown>[]).find(
            (p: Record<string, unknown>) => p.slug === name,
          ) as Record<string, unknown> | undefined;
          if (rootProjEntry) {
            rootProjEntry.completed = true;
            tasks.writePRD(rootPrd as unknown as import('../../../src/core/task-manager.js').PRD);
          }
        } catch (err: unknown) {
          log(`[DISCOVER] Failed to mark project completed: ${(err as Error).message}`);
        }
      }
    } else {
      let pendingCount = 0;
      let hasAnyReady = false;
      try {
        const projPrd = localTasks.readPRD() as unknown as Record<string, Record<string, unknown>[]>;
        const sarr = (projPrd.stories || []) as Record<string, unknown>[];
        pendingCount = sarr.filter((s) => !s.passes && s.status !== 'completed').length;
        hasAnyReady = sarr.some((s: Record<string, unknown>) => {
          if (s.passes || s.status === 'blocked') return false;
          const deps: string[] =
            (s._deps as string[]) ||
            (s.dependencies as string[]) ||
            (s.dependsOn as string[]) ||
            [];
          if (deps.length === 0) return true;
          return deps.every((depId: string) => {
            const dep = sarr.find((d: Record<string, unknown>) => String(d.id) === String(depId));
            return dep ? dep.passes : true;
          });
        });
      } catch {
        // Ignored
      }

      if (pendingCount > 0 && !hasAnyReady) {
        log(
          `[DISCOVER] Project ${name} has ${pendingCount} pending/blocked tasks but none ready. Running orchestrator to unblock...`,
        );
        tierSelector.applyTierConfig(tier, dir);
        const unblocker = new AgentRuntime({
          projectPath: dir,
          agentType: 'orchestrator',
          safety,
          stream,
        });
        await unblocker.run(180000);
      } else {
        log(
          `[DISCOVER] Project ${name} has pending tasks, skipping discovery to let IDLE process them.`,
        );
      }
    }
  }

  await tasks.loadTasks();
  if (
    notion &&
    typeof (notion as unknown as Record<string, unknown>).isReady === 'function' &&
    (notion as unknown as Record<string, () => boolean>).isReady()
  ) {
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

  stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
}
