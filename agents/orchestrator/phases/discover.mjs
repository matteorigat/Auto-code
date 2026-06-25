import { join, basename } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { TaskManager } from '../../../src/core/task-manager.mjs';
import config from '../../../src/config/index.mjs';
import { TierSelector } from '../../../src/core/tier-selector.mjs';

export async function handleDiscover(context) {
  const { tasks, state, projectPath, log, updateStatus, safety, stream, notion } = context;
  const { AgentRuntime } = await import('../../runtime.mjs');

  const tierSelector = new TierSelector();
  const tier = tierSelector.select('DISCOVER');

  updateStatus({ phase: 'DISCOVER' });
  log('[DISCOVER] running per-project bug-hunter + innovator');

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
    if (proj.pageId) {
      projectRegistry.set(proj.pageId, {
        slug: proj.slug,
        title: proj.title,
        dir: join(projectPath, 'projects', proj.slug),
      });
    }
  }

  const discoveryTargets =
    projectDirs.length > 0
      ? projectDirs
      : [...new Set([...projectRegistry.values()].map((p) => p.dir))];

  if (discoveryTargets.length === 0) {
    log('[DISCOVER] no project dirs to scan. Running global discovery.');
    discoveryTargets.push(projectPath);
  }

  for (const dir of discoveryTargets) {
    const name = basename(dir);
    log(`[DISCOVER] scanning ${name}`);

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
        } catch (e) {
          console.error('Ignored error:', e.message);
        }
      }
      search(dir, 1);
      return found;
    })();

    let storyCount = 0;
    const localTasks = new TaskManager({ projectPath: dir });
    try {
      const projPrd = localTasks.readPRD();
      storyCount = (projPrd.stories || []).length;
    } catch (e) {
      console.error('Ignored error:', e.message);
    }

    const isNewProject = storyCount <= 1;
    const hasSddArtifacts = [
      'PLAN.md',
      'PRODUCT-SPEC.md',
      'TECHNICAL-SPEC.md',
      'CONSTITUTION.md',
    ].some((f) => existsSync(join(dir, f)));

    if (!hasCode && !isNewProject && hasSddArtifacts) {
      log(`[DISCOVER] ${name}: no code yet, skipping`);
      continue;
    }

    const { bugHunterProbability = 0.3, innovatorProbability = 0.2 } = config.loop || {};

    tierSelector.applyTierConfig(tier, dir);

    if (Math.random() < bugHunterProbability) {
      log(`[DISCOVER] Invoking Bug Hunter in ${basename(dir)}`);
      const bugHunter = new AgentRuntime({ projectPath: dir, agentType: 'bug-hunter', stream });
      await bugHunter.run(300000); // 5 min
    }

    if (Math.random() < innovatorProbability) {
      const innovator = new AgentRuntime({ projectPath: dir, agentType: 'innovator', stream });
      await innovator.run(300000); // 5 min
    }

    const orch = new AgentRuntime({ projectPath: dir, agentType: 'orchestrator', stream });
    await orch.run(180000); // 3 min

    const tasksCount = localTasks.readPRD().stories?.length || 0;
    if (tasksCount === 0) {
      const planner = new AgentRuntime({ projectPath: dir, agentType: 'project-planner', stream });
      await planner.run(600000); // 10 min
    }

    try {
      const projPrd = localTasks.readPRD();
      const rootPrd = tasks.readPRD();
      const projEntry = (rootPrd.projects || []).find((p) => p.slug === name);
      if (projEntry) {
        for (const s of projPrd.stories || []) {
          if (!s.pageId && !s.passes) {
            const exists = (projEntry.stories || []).find((r) => String(r.id) === String(s.id));
            if (!exists) projEntry.stories.push(s);
          }
        }
        tasks.writePRD(rootPrd);
      }
    } catch (e) {
      console.error('Ignored error:', e.message);
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
