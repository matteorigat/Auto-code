import { join, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

export async function handleDiscover(context) {
  const { tasks, state, projectPath, log, updateStatus, safety, stream, notion } = context;
  const { AgentRuntime } = await import("../../runtime.mjs");

  updateStatus({ phase: "DISCOVER" });
  log("[DISCOVER] running per-project bug-hunter + innovator");

  const projectsDir = join(projectPath, "projects");
  let projectDirs = [];
  try {
    projectDirs = execSync(`ls -d "${projectsDir}"/*/ 2>/dev/null || true`, { shell: "/bin/bash", timeout: 5000 })
      .toString().trim().split("\\n").filter(Boolean);
  } catch {}

  const prd = tasks.readPRD();
  const projectRegistry = new Map();
  for (const proj of (prd.projects || [])) {
    if (proj.pageId) {
      projectRegistry.set(proj.pageId, {
        slug: proj.slug,
        title: proj.title,
        dir: join(projectPath, "projects", proj.slug),
      });
    }
  }

  const discoveryTargets = projectDirs.length > 0
    ? projectDirs
    : [...new Set([...projectRegistry.values()].map(p => p.dir))];

  if (discoveryTargets.length === 0) {
    log("[DISCOVER] no project dirs to scan. Running global discovery.");
    discoveryTargets.push(projectPath);
  }

  const getModel = () => process.env.OPENCODE_DEFAULT_MODEL || "openai/tier-4-planner";

  for (const dir of discoveryTargets) {
    const name = basename(dir);
    log(`[DISCOVER] scanning ${name}`);

    const hasCode = (() => {
      try { return execSync(`find "${dir}" -maxdepth 3 -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.tsx" -o -name "*.jsx" -o -name "*.css" -o -name "*.html" \\) 2>/dev/null | head -5`, { shell: "/bin/bash", timeout: 5000 }).toString().trim().length > 0; } catch { return false; }
    })();

    let storyCount = 0;
    try {
      const projPrd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
      storyCount = (projPrd.stories || []).length;
    } catch {}

    const isNewProject = storyCount <= 1;
    const hasSddArtifacts = ["PLAN.md", "PRODUCT-SPEC.md", "TECHNICAL-SPEC.md", "CONSTITUTION.md"].some(f => existsSync(join(dir, f)));

    if (!hasCode && !isNewProject && hasSddArtifacts) {
      log(`[DISCOVER] ${name}: no code yet, skipping`);
      continue;
    }

    if (Math.random() < 0.3) {
      const bugHunter = new AgentRuntime({ projectPath: dir, agentType: "bug-hunter", stream });
      await bugHunter.run(300000); // 5 min
    }

    if (Math.random() < 0.2) {
      const innovator = new AgentRuntime({ projectPath: dir, agentType: "innovator", stream });
      await innovator.run(300000); // 5 min
    }

    const orch = new AgentRuntime({ projectPath: dir, agentType: "orchestrator", stream });
    await orch.run(180000); // 3 min

    const tasksCount = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"))?.stories?.length || 0;
    if (tasksCount === 0) {
      const planner = new AgentRuntime({ projectPath: dir, agentType: "project-planner", stream });
      await planner.run(600000); // 10 min
    }

    try {
      const projPrd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
      const rootPrd = tasks.readPRD();
      const projEntry = (rootPrd.projects || []).find(p => p.slug === name);
      if (projEntry) {
        for (const s of (projPrd.stories || [])) {
          if (!s.pageId && !s.passes) {
            const exists = (projEntry.stories || []).find(r => String(r.id) === String(s.id));
            if (!exists) projEntry.stories.push(s);
          }
        }
        tasks.writePRD(rootPrd);
      }
    } catch {}
  }

  await tasks.loadTasks();
  if (notion.isReady()) {
    try {
      const currentPrd = tasks.readPRD();
      const allStories = [];
      for (const proj of (currentPrd.projects || [])) {
        for (const s of (proj.stories || [])) allStories.push(s);
      }
      for (const s of (currentPrd.crossProjectStories || [])) allStories.push(s);

      for (const s of allStories) {
        if (s.passes || s.pageId) continue;
        const pageId = await notion.createStory({
          storyId: s.id, title: s.title, description: s.description,
          acceptanceCriteria: s.acceptanceCriteria || [], priority: s.priority, tag: s.tag, status: "idle",
        }).catch(() => null);
        if (pageId) {
          s.pageId = pageId;
          tasks._persist();
          tasks.rebuildProjectFiles();
        }
      }
    } catch (e) { log(`[DISCOVER] Notion sync error: ${e.message}`); }
  }

  stream.emit("System", "system", { action: "PhaseChange", phase: "IDLE" });
}
