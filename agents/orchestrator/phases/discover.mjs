import { join, basename } from 'node:path';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { TaskManager } from '../../../src/core/task-manager.mjs';
import { TierSelector } from '../../../src/core/tier-selector.mjs';

export async function handleDiscover(context) {
  const { tasks, projectPath, log, updateStatus, safety, stream, notion } = context;
  const { AgentRuntime } = await import('../../runtime.mjs');

  const tierSelector = new TierSelector();
  const tier = tierSelector.select('DISCOVER');

  updateStatus({ phase: 'DISCOVER' });
  log('[DISCOVER] Running per-project planning and codebase quality audit');

  const projectsDir = join(projectPath, 'projects');
  let projectDirs = [];
  try {
    if (existsSync(projectsDir)) {
      projectDirs = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(projectsDir, d.name));
    }
  } catch (e) {
    console.error('Ignored error:', e.message);
  }

  const prd = tasks.readPRD();
  const projectRegistry = new Map();
  for (const proj of prd.projects || []) {
    const slug = proj.slug || proj.title || '';
    if (slug) {
      projectRegistry.set(slug, {
        slug: slug,
        title: proj.title || slug,
        dir: join(projectPath, 'projects', slug),
        description: proj.description || '',
        completed: proj.completed || false,
      });
    }
  }

  // Combine targets physically on disk and targets defined in registry
  const discoveryTargets = [
    ...new Set([...projectDirs, ...[...projectRegistry.values()].map((p) => p.dir)]),
  ];

  if (discoveryTargets.length === 0) {
    log('[DISCOVER] No project dirs to scan. Running global discovery.');
    discoveryTargets.push(projectPath);
  }

  for (const dir of discoveryTargets) {
    const name = basename(dir);

    // Skip if marked completed in registry
    const projRegistryEntry = projectRegistry.get(name);
    if (projRegistryEntry?.completed) {
      log(`[DISCOVER] Project ${name} is marked as fully completed, skipping.`);
      continue;
    }

    // 1. Ingest / Create Directory and ideas.md if missing
    if (!existsSync(dir)) {
      log(`[DISCOVER] Initializing project folder for ${name}`);
      try {
        mkdirSync(dir, { recursive: true });
        const ideasPath = join(dir, 'ideas.md');
        const ideasContent = `# ${projRegistryEntry?.title || name}\n\n${projRegistryEntry?.description || 'Nuova idea di progetto da pianificare e implementare.'}\n`;
        writeFileSync(ideasPath, ideasContent, 'utf-8');
      } catch (err) {
        log(`[DISCOVER] Failed to initialize project folder for ${name}: ${err.message}`);
        continue;
      }
    }

    const localTasks = new TaskManager({ projectPath: dir });
    let storyCount = 0;
    try {
      const projPrd = localTasks.readPRD();
      storyCount = (projPrd.stories || []).length;
    } catch (_) {
      // Ignored
    }

    const hasCode = (() => {
      let found = false;
      const exts = ['.js', '.ts', '.py', '.go', '.rs', '.tsx', '.jsx', '.css', '.html'];
      function search(curr, depth) {
        if (found || depth > 3) return;
        try {
          const files = readdirSync(curr, { withFileTypes: true });
          for (const f of files) {
            if (f.isDirectory() && !['node_modules', '.git', '.hydra'].includes(f.name)) {
              search(join(curr, f.name), depth + 1);
            } else if (f.isFile() && exts.some((e) => f.name.endsWith(e))) {
              found = true;
              return;
            }
          }
        } catch (_) {
          // Ignored
        }
      }
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

    // 2. New Project Spec Planning & Backlog Decomposition
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
      await planner.run(600000); // 10 min

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
        log(
          `[DISCOVER] project-planner finished. Backlog decomposed into ${rootProjEntry.stories.length} stories.`,
        );
      } catch (err) {
        log(`[DISCOVER] Failed to sync planned stories back to root: ${err.message}`);
      }

      // Transition back to IDLE to pick up the newly generated tasks!
      stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
      return;
    }

    // 3. Reflective Quality & Performance Audit Loop (when all backlog tasks are completed)
    let allStoriesCompleted = false;
    try {
      const projPrd = localTasks.readPRD();
      const stories = projPrd.stories || [];
      allStoriesCompleted =
        stories.length > 0 && stories.every((s) => s.passes || s.status === 'completed');
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

      // Run Bug Hunter (guaranteed)
      log(`[DISCOVER] Running Bug Hunter in ${name}`);
      const bugHunter = new AgentRuntime({
        projectPath: dir,
        agentType: 'bug-hunter',
        safety,
        stream,
      });
      await bugHunter.run(300000); // 5 min

      // Run Innovator (guaranteed)
      log(`[DISCOVER] Running Innovator in ${name}`);
      const innovator = new AgentRuntime({
        projectPath: dir,
        agentType: 'innovator',
        safety,
        stream,
      });
      await innovator.run(300000); // 5 min

      // Run Orchestrator (guaranteed)
      log(`[DISCOVER] Running Orchestrator Agent in ${name}`);
      const localOrch = new AgentRuntime({
        projectPath: dir,
        agentType: 'orchestrator',
        safety,
        stream,
      });
      await localOrch.run(180000); // 3 min

      let newTasksFound = false;
      try {
        const projPrd = localTasks.readPRD();
        const rootPrd = tasks.readPRD();
        const rootProjEntry = (rootPrd.projects || []).find((p) => p.slug === name);
        if (rootProjEntry) {
          for (const s of projPrd.stories || []) {
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
      } catch (err) {
        log(`[DISCOVER] Failed to sync audited stories back to root: ${err.message}`);
      }

      if (newTasksFound) {
        // Transition back to IDLE to start implementing the newly found bug fixes / features
        stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
        return;
      } else {
        // Audit passed with 0 new issues/ideas. Project is state-of-the-art and complete!
        log(`[DISCOVER] Audit passed with 0 new bugs or feature proposals.`);
        log(`[DISCOVER] Project ${name} is fully complete, runnable, and state-of-the-art!`);

        try {
          const rootPrd = tasks.readPRD();
          const rootProjEntry = (rootPrd.projects || []).find((p) => p.slug === name);
          if (rootProjEntry) {
            rootProjEntry.completed = true;
            tasks.writePRD(rootPrd);
          }
        } catch (err) {
          log(`[DISCOVER] Failed to mark project completed: ${err.message}`);
        }
      }
    } else {
      log(
        `[DISCOVER] Project ${name} has pending tasks, skipping discovery to let IDLE process them.`,
      );
    }
  }

  await tasks.loadTasks();
  if (notion.isReady()) {
    try {
      const currentPrd = tasks.readPRD();
      const allStories = [];
      for (const proj of currentPrd.projects || []) {
        for (const s of proj.stories || []) allStories.push(s);
      }
      for (const s of currentPrd.crossProjectStories || []) allStories.push(s);

      for (const s of allStories) {
        if (s.passes || s.pageId) continue;
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
    } catch (e) {
      log(`[DISCOVER] Notion sync error: ${e.message}`);
    }
  }

  stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
}
