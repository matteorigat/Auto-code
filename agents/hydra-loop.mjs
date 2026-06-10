#!/usr/bin/env node
/**
 * Hydra Loop — 24/7 Autonomous Agent Orchestrator
 *
 * Architecture:
 *   Phase State Machine: IDLE → PLAN → EXEC → QA → COMMIT → SYNC → IDLE
 *   Durable checkpoint after every transition
 *   Notion as task source-of-truth
 *   Telegram as real-time dashboard + Human-in-the-Loop
 *   Fresh context per micro-task (Ralph)
 *   Event-sourced recovery (OpenHands)
 *
 * Project structure:
 *   /home/.../loop/
 *     .hydra/                     # Loop state (checkpoint, heartbeat)
 *     prd.json                    # Global stories (meta, cross-project)
 *     progress.txt                # Global progress
 *     bugs.md                     # Cross-project bugs
 *     ideas.md                    # Cross-project ideas
 *     projects/
 *       app-di-libri-usati/       # One dir per Notion project
 *         .git/                   # Own git history
 *         prd.json                # Stories for this project
 *         progress.txt
 *         bugs.md
 *         ideas.md
 *         ... (generated code)
 *       ...
 */
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watch } from "node:fs";
import { execSync, spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mod = (p) => join(__dirname, "..", p);

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

async function main() {
  const args = process.argv.slice(2);
  const projectPath = args[0];
  if (!projectPath) {
    console.error("Usage: node agents/hydra-loop.mjs <project-path> [--notion-page <id>] [--tag <project-tag>] [--chat-id <id>]");
    process.exit(1);
  }

  const extract = (name) => {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  const notionPageId = extract("--notion-page");
  const projectTag = extract("--tag") || basename(projectPath);
  const chatIdOverride = extract("--chat-id");

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error("Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }

  // ─── Load modules ───
  const { getDurableState } = await import(mod("lib/durable-state.mjs"));
  const { TaskManager } = await import(mod("lib/task-manager.mjs"));
  const { AgentRuntime } = await import(mod("lib/agent-runtime.mjs"));
  const { TelegramChannel } = await import(mod("lib/telegram-channel.mjs"));
  const { MemoryManager } = await import(mod("lib/memory-manager.mjs"));
  const { QualityGate } = await import(mod("lib/quality-gate.mjs"));
  const { Safety } = await import(mod("lib/safety.mjs"));
  const { default: NotionAdapter } = await import(mod("lib/notion-adapter.mjs"));

  const state = getDurableState(projectPath);
  const checkpoint = state.load();

  const notion = new NotionAdapter({
    token: process.env.NOTION_API_TOKEN,
    databaseId: process.env.NOTION_DATABASE_ID || notionPageId,
    pageId: process.env.NOTION_PAGE_ID || notionPageId,
    projectTag: projectTag && projectTag !== ".hydra" ? projectTag : undefined,
  });
  const telegram = new TelegramChannel({
    botToken: token,
    chatId: chatIdOverride || process.env.HYDRA_CHAT_ID || null,
    onMessageSent: (msgId, cid) => {
      const path = join(__dirname, "..", ".hydra", "loop-msg-ids.json");
      try {
        const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : [];
        existing.push({ id: msgId, chatId: cid, ts: Date.now() });
        writeFileSync(path, JSON.stringify(existing));
      } catch {}
    },
  });
  const tasks = new TaskManager({ projectPath, notionAdapter: notion });
  const memory = new MemoryManager(projectPath);
  const safety = new Safety(projectPath);
  const gate = new QualityGate(projectPath);

  if (!telegram.chatId) {
    try {
      const bridgeStatePath = join(__dirname, "..", ".hydra", "bridge-chat.json");
      if (existsSync(bridgeStatePath)) {
        const b = JSON.parse(readFileSync(bridgeStatePath, "utf-8"));
        telegram.chatId = b.chatId || null;
      }
    } catch {}
  }

  await telegram.initPinned();

  // ─── Project Registry ───
  // Maps Notion pageId → { slug, title, dir }
  const projectRegistry = new Map();

  // Refresh in-memory registry from root prd.json (called every IDLE cycle)
  function _refreshRegistry() {
    projectRegistry.clear();
    const prd = tasks.readPRD();
    for (const proj of (prd.projects || [])) {
      if (proj.pageId) {
        projectRegistry.set(proj.pageId, {
          slug: proj.slug,
          title: proj.title,
          dir: join(projectPath, "projects", proj.slug),
        });
      }
    }
  }

  // Initialize a project directory: mkdir, git init, per-project stubs
  function _initProjectDirectory(dir, title) {
    try { mkdirSync(dir, { recursive: true }); } catch (e) {
      log(`INIT — mkdir ${basename(dir)}: ${e.message}`); return;
    }
    try { execSync("git rev-parse --git-dir", { cwd: dir, shell: "/bin/bash", timeout: 5000 }); } catch {
      log(`INIT — git init ${basename(dir)}`);
      execSync("git init", { cwd: dir, shell: "/bin/bash", timeout: 10000 });
      execSync("git config user.email hydra-loop@opencode.ai && git config user.name 'Hydra Loop'", { cwd: dir, shell: "/bin/bash", timeout: 5000 });
      const gi = join(dir, ".gitignore");
      if (!existsSync(gi)) writeFileSync(gi, ["node_modules", ".next", ".env", "*.log", ".DS_Store", ".hydra/", "archive/"].join("\n") + "\n");
      try { execSync("git add -A && git commit -m \"chore: init\"", { cwd: dir, shell: "/bin/bash", timeout: 15000 }); } catch {}
    }
    if (!existsSync(join(dir, "prd.json")))
      writeFileSync(join(dir, "prd.json"), JSON.stringify({ project: title, description: "", stories: [], codebasePatterns: "" }, null, 2));
    for (const f of ["progress.txt", "bugs.md", "ideas.md"]) {
      const fp = join(dir, f);
      if (!existsSync(fp)) writeFileSync(fp, `# ${title} — ${f}\n\n`);
    }

    // Ensure .opencode/opencode.json exists and routes openai to LiteLLM proxy
    const opencodeDir = join(dir, ".opencode");
    if (!existsSync(opencodeDir)) {
      try { mkdirSync(opencodeDir, { recursive: true }); } catch {}
    }
    const opencodeConfigPath = join(opencodeDir, "opencode.json");
    if (!existsSync(opencodeConfigPath)) {
      try {
        writeFileSync(opencodeConfigPath, JSON.stringify({
          "$schema": "https://opencode.ai/config.json",
          "permission": "allow",
          "model": "openai/tier-4-planner",
          "compaction": { "auto": true, "prune": true, "reserved": 30000 },
          "provider": {
            "openai": {
              "options": {
                "baseURL": "http://127.0.0.1:4000/v1"
              }
            }
          }
        }, null, 2));
      } catch {}
    }
  }

  // Init all known project dirs at startup
  async function _initProjectDirs() {
    _refreshRegistry();
    for (const [, proj] of projectRegistry) {
      _initProjectDirectory(proj.dir, proj.title);
      log(`INIT — ${proj.slug} ready`);
    }
  }

  // Check Notion for new projects not yet in root prd.json
  // Returns array of { slug, title, dir } for new projects discovered
  async function _syncNewProjectsFromNotion() {
    if (!notion.isReady()) return [];

    const prd = tasks.readPRD();
    const existingPageIds = new Set(
      (prd.projects || []).filter(p => p.pageId).map(p => p.pageId)
    );

    let notionTasks = [];
    try { notionTasks = await notion.pullTasks(); } catch { return []; }

    const newProjects = [];
    for (const nt of notionTasks) {
      const pid = nt.pageId || nt.storyId;
      if (!pid || existingPageIds.has(pid) || !nt.title || nt.excluded) continue;

      const slug = slugify(nt.title);
      const dir = join(projectPath, "projects", slug);

      // Add to root prd.json
      prd.projects.push({
        slug, title: nt.title, pageId: pid, stories: [],
        description: nt.description || "", codebasePatterns: "",
      });

      // Add to in-memory registry
      projectRegistry.set(pid, { slug, title: nt.title, dir });

      // Create directory + git init + stubs
      _initProjectDirectory(dir, nt.title);

      existingPageIds.add(pid);
      newProjects.push({ slug, title: nt.title, dir });
      log(`NEW PROJECT from Notion: ${nt.title} → ${slug}`);
    }

    if (newProjects.length > 0) {
      tasks.writePRD(prd);
      sendAlert("info", `New project(s) discovered: ${newProjects.map(p => p.title).join(", ")}`);
    }

    return newProjects;
  }

  // Assign _projectSlug to tasks that came from Notion merge without one
  function _assignPendingTasksToProjects() {
    let count = 0;
    for (const task of tasks._tasks) {
      if (task._projectSlug) continue;
      const dir = _resolveProjectDir(task);
      if (dir && dir !== projectPath) {
        task._projectSlug = basename(dir);
        task.workspacePath = dir;
        count++;
      }
    }
    if (count > 0) log(`ASSIGN — ${count} tasks assigned to projects`);
  }

  // ─── Per-project pause mechanism ───
  // Instead of pausing the entire loop, only the affected project is paused.
  // Other projects continue to be processed.
  const pausedPath = join(projectPath, ".hydra", "paused-projects.json");

  function _readPaused() {
    try { return JSON.parse(readFileSync(pausedPath, "utf-8")); } catch { return {}; }
  }

  function _writePaused(p) {
    writeFileSync(pausedPath, JSON.stringify(p, null, 2));
  }

  function _pauseProject(slug, reason, taskId, taskTitle) {
    const paused = _readPaused();
    if (paused[slug]) return; // already paused
    paused[slug] = { reason, taskId, taskTitle, pausedAt: new Date().toISOString() };
    _writePaused(paused);
    sendAlert("warn", `Project paused: ${slug} — ${reason}`);
    log(`PAUSE — ${slug}: ${reason}`);
  }

  function _unpauseProject(slug) {
    const paused = _readPaused();
    if (!paused[slug]) return;
    delete paused[slug];
    _writePaused(paused);
    sendAlert("info", `Project resumed: ${slug}`);
    log(`UNPAUSE — ${slug}`);
  }

  function _isProjectPaused(slug) {
    const paused = _readPaused();
    return !!paused[slug];
  }

  function _isTaskProjectPaused(task) {
    const slug = task._projectSlug || (task.workspacePath ? basename(task.workspacePath) : null);
    return slug ? _isProjectPaused(slug) : false;
  }

  function _resolveProjectDir(story) {
    // 1. pageId match
    if (story.pageId && projectRegistry.has(story.pageId))
      return projectRegistry.get(story.pageId).dir;

    // 2. Description mentions an existing project
    const haystack = (story.description || "") + " " + (story.title || "");
    const projMatch = haystack.match(/projects\/([a-zA-Z0-9_-]+)\//);
    if (projMatch) {
      const slug = projMatch[1];
      const dir = join(projectPath, "projects", slug);
      if (existsSync(dir)) return dir;
      for (const [, p] of projectRegistry) { if (p.slug === slug) return p.dir; }
    }

    // 3. _deps reference a known project story
    if (story._deps && story._deps.length > 0) {
      for (const depId of story._deps) {
        for (const [pid, proj] of projectRegistry) {
          if (depId === pid || depId.startsWith(pid.slice(0, 8))) return proj.dir;
        }
      }
    }

    // 4. Story title mentions a project name
    for (const [, proj] of projectRegistry) {
      const words = proj.title.toLowerCase().split(/\s+/);
      if (words.some(w => w.length > 3 && haystack.toLowerCase().includes(w))) return proj.dir;
    }

    // 5. Already has workspacePath pointing to an existing projects dir
    if (story.workspacePath && story.workspacePath.startsWith(join(projectPath, "projects")) && existsSync(story.workspacePath))
      return story.workspacePath;

    // 6. Fallback: root
    return projectPath;
  }

  // ─── Helpers ───
  const log = (msg) => {
    const time = new Date().toISOString().slice(11, 19);
    console.log(`[${time}] ${msg}`);
    memory.appendEvent("log", { message: msg });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── Sync a story's status back to its project prd.json ───
  function _syncProjectPrd(story) {
    if (!story) return;
    if (story._projectSlug) {
      tasks._syncProjectFiles(story);
    } else {
      // Fallback: resolve dir and write directly
      const dir = story.workspacePath || _resolveProjectDir(story);
      const projPrdPath = join(dir, "prd.json");
      if (!existsSync(projPrdPath)) return;
      try {
        const projPrd = JSON.parse(readFileSync(projPrdPath, "utf-8"));
        const existingIdx = projPrd.stories.findIndex(s => String(s.id) === String(story.id));
        if (existingIdx >= 0) {
          projPrd.stories[existingIdx] = { ...projPrd.stories[existingIdx], ...story };
        } else {
          projPrd.stories.push(story);
        }
        writeFileSync(projPrdPath, JSON.stringify(projPrd, null, 2));
      } catch {}
    }
  }

  // ─── Git init root ───
  try { execSync("git rev-parse --git-dir", { cwd: projectPath, shell: "/bin/bash", timeout: 5000 }); } catch {
    log("INIT — git init root");
    execSync("git init", { cwd: projectPath, shell: "/bin/bash", timeout: 10000 });
    execSync("git config user.email hydra-loop@opencode.ai && git config user.name 'Hydra Loop'", { cwd: projectPath, shell: "/bin/bash", timeout: 5000 });
    const gi = join(projectPath, ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, ["node_modules", ".next", ".env", "*.log", ".DS_Store", ".hydra/", "archive/"].join("\n") + "\n");
    try { execSync("git add -A && git commit -m \"chore: init\"", { cwd: projectPath, shell: "/bin/bash", timeout: 15000 }); } catch {}
  }

  // ─── Init project dirs from root prd.json ───
  _refreshRegistry();
  await _initProjectDirs();

  const sendAlert = async (level, text) => { log(`[${level.toUpperCase()}] ${text}`); await telegram.alert(level, text); };
  const updateStatus = (delta) => { 
    telegram.updateStatus(delta); 
    try {
      const statePath = join(projectPath, ".hydra", "loop-state.json");
      writeFileSync(statePath, JSON.stringify(telegram._status, null, 2));
    } catch {}
  };

  // ─── Model pool ───
  const modelPool = (() => {
    try { return JSON.parse(readFileSync(join(__dirname, "..", "config", "model-pool.json"), "utf-8")).models || []; } catch { return []; }
  })();
  const getModelForPhase = (phase) => {
    if (modelPool.length === 0) return process.env.OPENCODE_DEFAULT_MODEL || "openai/tier-4-planner";
    const tierMap = { DISCOVER: 1, EXEC: 2, FIX: 2, QA: 1, IDLE: 1, PLAN: 1, COMMIT: 1, SYNC: 1 };
    const candidates = modelPool.filter(m => m.tier >= (tierMap[phase] || 1));
    return candidates.length ? candidates.reduce((best, m) => m.tier < best.tier ? m : best, candidates[0]).id : modelPool[0].id;
  };

  // ─── Phase handlers ───

  async function phaseIDLE() {
    state.transition("IDLE");

    // Refresh registry and check for new projects from Notion
    _refreshRegistry();
    const newProjects = await _syncNewProjectsFromNotion();

    // Load and merge tasks (root + Notion)
    await tasks.loadTasks();

    // Assign unassigned Notion tasks to their project
    _assignPendingTasksToProjects();

    // Auto-unpause projects whose conditions no longer apply
    const paused = _readPaused();
    for (const [slug, info] of Object.entries(paused)) {
      let shouldUnpause = false;
      if (info.reason === "budget exceeded" && !safety.isOverBudget()) shouldUnpause = true;
      if (info.reason && info.reason.startsWith("stagnation:")) {
        // Auto-unpause after 5 minutes
        const pausedMs = Date.now() - new Date(info.pausedAt).getTime();
        if (pausedMs > 300_000) shouldUnpause = true;
      }
      // Check per-project resume signal
      const resumeSignal = join(projectPath, "projects", slug, ".hydra", "resume-signal.json");
      if (existsSync(resumeSignal)) {
        shouldUnpause = true;
        try { unlinkSync(resumeSignal); } catch {}
      }
      if (shouldUnpause) _unpauseProject(slug);
    }

    // Count only non-paused pending tasks
    const allTasks = tasks._tasks || [];
    const available = allTasks.filter(t => !_isTaskProjectPaused(t));
    const left = available.filter(t => !t.passes && t.status !== "blocked").length;
    const blocked = allTasks.filter(t => t.status === "blocked").length;
    const done = allTasks.filter(t => t.passes).length;

    const st = tasks.stats(); // original stats for totals
    updateStatus({ phase: "IDLE", taskTitle: "Waiting for tasks\u2026", cost: safety.getDailyCost(), tasksCompleted: done, tasksBlocked: blocked, tasksTotal: st.total, lastError: null });
    log(`IDLE \u2014 ${done}/${st.total} done, ${left} available, ${blocked} blocked, ${Object.keys(paused).length} paused`);

    if (newProjects.length > 0) {
      sendAlert("info", `Running discovery on new project(s): ${newProjects.map(p => p.title).join(", ")}`);
      return "DISCOVER";
    }

    if (left === 0) {
      if (blocked === 0 && Object.keys(paused).length === 0) { sendAlert("info", "No pending tasks. Running discovery agents\u2026"); return "DISCOVER"; }
      if (blocked > 0) sendAlert("warn", `All ${blocked} remaining tasks are BLOCKED. Fix blocks in Notion or prd.json to resume.`);
      if (Object.keys(paused).length > 0) sendAlert("info", `${Object.keys(paused).length} project(s) paused — other projects idle. Waiting for resume or unpause.`);
      return "WAIT_HUMAN";
    }
    return "PLAN";
  }

  async function phasePLAN() {
    state.transition("PLAN");

    // Find next pending task from a non-paused project
    let task = null;
    let candidates = tasks._tasks.filter(t => {
      const slug = t._projectSlug || (t.workspacePath ? basename(t.workspacePath) : null);
      return slug ? !_isProjectPaused(slug) : true;
    });
    // Keep original ordering (topological sort from getNextPending)
    const allPending = tasks.getNextPending();
    if (allPending) {
      // Use the first candidate that matches original order
      task = candidates.find(t => String(t.id) === String(allPending.id)) || candidates[0];
    }
    if (!task) {
      const paused = _readPaused();
      if (Object.keys(paused).length > 0) {
        log(`PLAN — all remaining tasks are in paused projects`);
        return "IDLE";
      }
      return "IDLE";
    }

    if (tasks.needsSplitting(task)) {
      log(`Story ${task.id} too large — splitting`);
      const parts = tasks.splitStory(task);
      tasks._tasks = tasks._tasks.filter((t) => String(t.id) !== String(task.id));
      for (const p of parts) tasks.addStory(p);
      candidates = tasks._tasks.filter(t => {
        const slug = t._projectSlug || (t.workspacePath ? basename(t.workspacePath) : null);
        return slug ? !_isProjectPaused(slug) : true;
      });
      task = candidates[0] || tasks.getNextPending();
      if (!task) return "IDLE";
    }

    state.transition("PLAN", { currentTaskId: task.id, currentStory: task.title, attempt: 0 });
    updateStatus({ phase: "PLAN", taskTitle: task.title, taskId: task.id, project: projectTag });
    log(`PLAN \u2014 next task: ${task.id} ${task.title}`);

    // Init project dir for this task (resolve, don't create new)
    await _initTaskProject(task);

    // Run SDD task-planner: generate specs and test stubs for this task
    const planDir = task.workspacePath || projectPath;
    const hasSddArtifacts = ["PLAN.md", "PRODUCT-SPEC.md", "TECHNICAL-SPEC.md", "CONSTITUTION.md"]
      .some(f => existsSync(join(planDir, f)));

    if (hasSddArtifacts) {
      log(`PLAN \u2014 running task-planner for ${task.id} ${task.title}`);
      const taskPlanner = new AgentRuntime({ projectPath: planDir, agentType: "task-planner", task });
      await taskPlanner.run(300_000).catch(() => {});
    } else {
      log(`PLAN \u2014 no SDD artifacts found, skipping task-planner`);
    }

    return "EXEC";
  }

  async function _initTaskProject(task) {
    const projectDir = _resolveProjectDir(task);
    _initProjectDirectory(projectDir, basename(projectDir));

    // Ensure this story exists in the project's prd.json
    const projPrdPath = join(projectDir, "prd.json");
    let projPrd = { project: basename(projectDir), description: "", stories: [], codebasePatterns: "" };
    try { projPrd = JSON.parse(readFileSync(projPrdPath, "utf-8")); } catch {}
    const existingIdx = projPrd.stories.findIndex(s => String(s.id) === String(task.id));
    if (existingIdx < 0) {
      projPrd.stories.push({
        id: task.id, title: task.title, description: task.description || "",
        acceptanceCriteria: task.acceptanceCriteria || [], priority: task.priority || 3, passes: false,
      });
      writeFileSync(projPrdPath, JSON.stringify(projPrd, null, 2));
    }

    writeFileSync(join(projectPath, ".task-current.json"), JSON.stringify({
      taskId: task.id, title: task.title, description: task.description || "",
      tag: task.tag || "", slug: basename(projectDir), workspacePath: projectDir,
      selectedAt: new Date().toISOString(), notionUrl: task.url || "",
    }, null, 2));

    task.workspacePath = projectDir;
    task._projectSlug = basename(projectDir);
    tasks._syncProjectFiles(task);
    log(`INIT \u2014 ${task.id.slice(0, 8)}\u2026 → ${basename(projectDir)}`);
    return projectDir;
  }

  async function phaseEXEC() {
    const taskId = state.get().currentTaskId;
    const task = tasks._tasks.find((t) => String(t.id) === String(taskId));
    if (!task) return "IDLE";

    state.transition("EXEC", { attempt: (state.get().attempt || 0) + 1 });
    updateStatus({ phase: "EXEC", taskTitle: task.title, taskId: task.id });

    const ws = task.workspacePath || projectPath;
    safety.snapshotBeforeWork(taskId, ws);

    const runtime = new AgentRuntime({ projectPath: ws, agentType: "builder", task, safety });

    let result = null;

    runtime.on("thinking", () => updateStatus({ phase: "THINKING" }));
    runtime.on("toolCall", ({ tool, title }) => updateStatus({ phase: `TOOL:${tool}` }));
    runtime.on("cost", ({ cost }) => { safety.addCost(cost); updateStatus({ cost: safety.getDailyCost() }); });
    // human gates are auto-approved by AgentRuntime (LLM has full PC access)
    runtime.on("stagnation", (data) => {
      // Pause the affected project, not the whole loop
      const slug = task._projectSlug || basename(task.workspacePath || "");
      _pauseProject(slug, `stagnation: ${data.message} (${data.occurrences}x)`, taskId, task.title);
    });

    try { result = await runtime.run(safety.maxCycleMs()); } catch (e) { result = { ok: false, error: e.message }; }

    if (safety.isOverBudget()) {
      const slug = task._projectSlug || basename(task.workspacePath || "");
      _pauseProject(slug, "budget exceeded", taskId, task.title);
      sendAlert("critical", `Daily cost budget exceeded. Project paused: ${slug}`);
      return "SYNC";
    }
    if (!result.ok) {
      const err = result.error || "Unknown error";
      memory.appendProgress({ phase: "EXEC", taskId, qa: `FAIL: ${err}`, cost: safety.getDailyCost() });
      state.transition("FIX", { previousError: err });
      return "FIX";
    }

    memory.appendProgress({ phase: "EXEC", taskId, summary: "Builder completed", cost: safety.getDailyCost() });
    return "QA";
  }

  async function phaseQA() {
    const taskId = state.get().currentTaskId;
    const task = tasks._tasks.find((t) => String(t.id) === String(taskId));
    const ws = task?.workspacePath || projectPath;
    state.transition("QA");
    updateStatus({ phase: "QA", taskTitle: state.get().currentStory, taskId });
    log(`QA \u2014 running gates for ${taskId}`);

    const hasPackageJson = existsSync(join(ws, "package.json"));
    const hasOtherConfig = existsSync(join(ws, "pyproject.toml")) || existsSync(join(ws, "requirements.txt")) || existsSync(join(ws, "go.mod")) || existsSync(join(ws, "Cargo.toml"));

    if (!hasPackageJson && !hasOtherConfig) {
      log("QA \u2014 skip (no package.json or other project config)");
      tasks.markPass(taskId);
      _syncProjectPrd(task);
      if (notion.isReady()) { try { await notion.pushProgress({ pageId: tasks._tasks.find((t) => String(t.id) === String(taskId))?.pageId, status: "completed" }); } catch {} }
      memory.appendProgress({ phase: "QA", taskId, qa: "PASS (skipped - no project config)", cost: safety.getDailyCost() });
      return "COMMIT";
    }

    const port = (() => { try { return readFileSync(join(ws, ".port"), "utf-8").trim(); } catch { return null; } })();
    const qa = await gate.run({ appPort: port, cwd: ws });
    await sendAlert(qa.passed ? "info" : "warn", `QA ${qa.passed ? "\u2705 passed" : "\u274c failed"}\n${qa.results.map((r) => `${r.name}: ${r.passed ? "OK" : "FAIL"} (${r.required ? "required" : "optional"})`).join("\n")}`);

    if (qa.passed) {
      tasks.markPass(taskId);
      _syncProjectPrd(task);
      if (notion.isReady()) { try { await notion.pushProgress({ pageId: tasks._tasks.find((t) => String(t.id) === String(taskId))?.pageId, status: "completed" }); } catch {} }
      memory.appendProgress({ phase: "QA", taskId, qa: "PASS", cost: safety.getDailyCost() });
      return "COMMIT";
    }

    const failedChecks = qa.results.filter((r) => !r.passed && r.required);
    const failedDetails = qa.results.filter((r) => !r.passed).map((r) => `  - ${r.name}: exitCode=${r.exitCode}\n    ${r.output.slice(0, 400).replace(/\\n/g, " ")}`).join("\n");
    log(`QA FAILED \u2014 required: [${failedChecks.map(r => r.name).join(", ")}]\n${failedDetails}`);
    memory.appendEvent("qa-failure", { taskId, failedChecks: failedChecks.map(r => r.name), details: failedDetails, cost: safety.getDailyCost() });
    safety.rollbackLastSnapshot(taskId, ws);
    state.transition("FIX", { previousError: `QA failed: ${failedChecks.map((r) => r.name).join(", ")}` });
    return "FIX";
  }

  async function phaseCOMMIT() {
    const taskId = state.get().currentTaskId;
    const task = tasks._tasks.find((t) => String(t.id) === String(taskId));
    const ws = task?.workspacePath || projectPath;
    state.transition("COMMIT");
    updateStatus({ phase: "COMMIT", taskTitle: state.get().currentStory, taskId });
    log(`COMMIT \u2014 git commit in ${ws}`);

    try { execSync("git rev-parse --git-dir", { cwd: ws, shell: "/bin/bash", timeout: 5000 }); } catch {
      execSync("git init", { cwd: ws, shell: "/bin/bash", timeout: 10000 });
      execSync("git config user.email hydra-loop@opencode.ai && git config user.name 'Hydra Loop'", { cwd: ws, shell: "/bin/bash", timeout: 5000 });
    }

    try {
      execSync(`git add -A && git commit -m "feat(${taskId}): ${state.get().currentStory}"`, { cwd: ws, shell: "/bin/bash", timeout: 15000 });
      sendAlert("info", `Committed feat(${taskId}): ${state.get().currentStory}`);
    } catch (e) {
      log(`COMMIT Error \u2014 git commit failed: ${e.message}`);
    }

    _syncProjectPrd(task);
    return "REFLECT";
  }

  async function phaseREFLECT() {
    const taskId = state.get().currentTaskId;
    const task = tasks._tasks.find((t) => String(t.id) === String(taskId));
    const ws = task?.workspacePath || projectPath;
    
    state.transition("REFLECT");
    updateStatus({ phase: "REFLECT", taskTitle: state.get().currentStory, taskId });
    log("REFLECT \u2014 extracting reusable skills");

    try {
      // Ottieni il diff appena committato per il contesto
      const diff = execSync("git diff HEAD~1 HEAD", { cwd: ws, shell: "/bin/bash", timeout: 10000 }).toString();
      if (!diff.trim()) {
        log("REFLECT \u2014 no diff found, skipping");
        return "SYNC";
      }

      const agent = new AgentRuntime({ projectPath, agentType: "skill-extractor", safety });
      agent.task = { title: state.get().currentStory, description: diff };

      const result = await agent.run(120000); // 2 min timeout
      if (result.ok && (result.content || result.result?.info?.content)) {
        const skillContent = result.content || result.result.info.content;
        if (!skillContent.includes("NO_SKILL") && skillContent.length > 50) {
          const skillsDir = join(projectPath, ".hydra", "skills");
          if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
          
          const titleMatch = skillContent.match(/^#\s+(.+)$/m);
          let safeTitle = taskId;
          if (titleMatch) {
            safeTitle = titleMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
          }
          const filename = `skill-${safeTitle}-${Date.now().toString(36)}.md`;
          
          writeFileSync(join(skillsDir, filename), skillContent, "utf-8");
          log(`REFLECT \u2014 extracted skill saved to ${filename}`);
        } else {
          log("REFLECT \u2014 task deemed trivial, no skill extracted");
        }
      }
    } catch (err) {
      log(`REFLECT error (non-fatal): ${err.message}`);
    }

    return "SYNC";
  }

  async function phaseSYNC() {
    state.transition("SYNC");
    updateStatus({ phase: "SYNC" });
    log("SYNC \u2014 pushing to Notion");
    if (notion.isReady()) {
      try { await notion.syncLocalPRD(projectPath, tasks.readPRD()); } catch (e) { log(`Notion sync error: ${e.message}`); }
    }
    tasks._persist();
    tasks.rebuildProjectFiles();
    if (memory.needsCompaction()) { 
      try { 
        await memory.compact(() => new AgentRuntime({ projectPath, agentType: "summarizer", safety })); 
      } catch (e) { log(`Compact error: ${e.message}`); } 
    }
    state.transition("IDLE", { currentTaskId: null, currentStory: null, previousError: null });
    return "IDLE";
  }

  async function phaseFIX() {
    const s = state.get();
    const errorMsg = s.previousError || "Unknown error";
    updateStatus({ lastError: errorMsg.slice(0, 200) });
    if ((s.attempt || 0) >= (s.maxAttempts || 3)) {
      sendAlert("critical", `Task ${s.currentTaskId} exhausted attempts. Marking BLOCKED and pausing project.`);
      tasks.markBlocked(s.currentTaskId, s.previousError || "Max attempts reached");
      const task = tasks._tasks.find((t) => String(t.id) === String(s.currentTaskId));
      if (task) {
        const slug = task._projectSlug || basename(task.workspacePath || "");
        _pauseProject(slug, `max attempts (${s.attempt})`, s.currentTaskId, s.currentStory);
      }
      _syncProjectPrd(task);
      if (notion.isReady()) { try { await notion.pushProgress({ pageId: tasks._tasks.find((t) => String(t.id) === String(s.currentTaskId))?.pageId, status: "blocked" }); } catch {} }
      state.transition("IDLE", { currentTaskId: null, currentStory: null });
      return "IDLE";
    }

    const task = tasks._tasks.find((t) => String(t.id) === String(s.currentTaskId));
    if (task) {
      const ws = task.workspacePath || projectPath;
      log(`FIX \u2014 rolling back snapshot for ${s.currentTaskId} before retry #${(s.attempt || 0) + 1}`);
      safety.rollbackLastSnapshot(s.currentTaskId, ws);
    }
    return "EXEC";
  }

  async function phaseDISCOVER() {
    state.transition("DISCOVER");
    updateStatus({ phase: "DISCOVER" });
    log("DISCOVER \u2014 running per-project bug-hunter + innovator");

    const projectsDir = join(projectPath, "projects");
    let projectDirs = [];
    try { projectDirs = readFileSync(projectsDir, "utf-8") ? [] : []; } catch {}
    try {
      projectDirs = execSync(`ls -d "${projectsDir}"/*/ 2>/dev/null || true`, { shell: "/bin/bash", timeout: 5000 })
        .toString().trim().split("\n").filter(Boolean);
    } catch {}

    const discoveryTargets = projectDirs.length > 0
      ? projectDirs
      : [...new Set([...projectRegistry.values()].map(p => p.dir))];

    if (discoveryTargets.length === 0) {
      log("DISCOVER \u2014 no project dirs to scan. Running global discovery.");
      discoveryTargets.push(projectPath);
    }

    // Run bug-hunter + innovator on each project
    for (const dir of discoveryTargets) {
      const name = basename(dir);
      log(`DISCOVER \u2014 scanning ${name}`);

      // Check if project has code; also run discovery on new projects even without code
      const hasCode = (() => {
        try { return execSync(`find "${dir}" -maxdepth 3 -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.tsx" -o -name "*.jsx" -o -name "*.css" -o -name "*.html" \\) 2>/dev/null | head -5`, { shell: "/bin/bash", timeout: 5000 }).toString().trim().length > 0; } catch { return false; }
      })();

      // Count existing stories to detect new projects
      let storyCount = 0;
      try {
        const projPrd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
        storyCount = (projPrd.stories || []).length;
      } catch {}

      const isNewProject = storyCount <= 1;
      const hasSddArtifacts = ["PLAN.md", "PRODUCT-SPEC.md", "TECHNICAL-SPEC.md", "CONSTITUTION.md"].some(f => existsSync(join(dir, f)));

      if (!hasCode && !isNewProject && hasSddArtifacts) {
        log(`DISCOVER \u2014 ${name}: no code yet, skipping`);
        continue;
      }

      // Per-project bug-hunter (skip for brand-new projects with no code)
      if (hasCode) {
        const bugHunter = new AgentRuntime({ projectPath: dir, agentType: "bug-hunter" });
        await bugHunter.run(600_000).catch((e) => log(`DISCOVER \u2014 bug-hunter error: ${e.message}`));
      }

      // Per-project innovator (always run, even for new projects)
      const innovator = new AgentRuntime({ projectPath: dir, agentType: "innovator" });
      await innovator.run(600_000).catch((e) => log(`DISCOVER \u2014 innovator error: ${e.message}`));

      // Per-project orchestrator: reads bugs.md + ideas.md, writes stories to project prd.json
      const orch = new AgentRuntime({ projectPath: dir, agentType: "orchestrator" });
      await orch.run(600_000).catch((e) => log(`DISCOVER \u2014 orchestrator error: ${e.message}`));

      // Per-project planner: creates implementation plan before builder runs if missing SDD artifacts
      if (!hasSddArtifacts) {
        log(`DISCOVER — ${name}: generating implementation plan (missing SDD artifacts)`);
        const planner = new AgentRuntime({ projectPath: dir, agentType: "project-planner" });
        await planner.run(600_000).catch((e) => log(`DISCOVER \u2014 project-planner error: ${e.message}`));
      }

      // Sync discovered stories into the project entry in root prd.json
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

    // Reload tasks and sync new stories to Notion
    await tasks.loadTasks();
    if (notion.isReady()) {
      try {
        const prd = tasks.readPRD();
        const allStories = [];
        for (const proj of (prd.projects || [])) {
          for (const s of (proj.stories || [])) allStories.push(s);
        }
        for (const s of (prd.crossProjectStories || [])) allStories.push(s);

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
      } catch (e) { log(`DISCOVER \u2014 Notion sync error: ${e.message}`); }
    }
    return "IDLE";
  }

  async function phaseWAIT_HUMAN() {
    const s = state.get();
    updateStatus({ phase: "WAIT_HUMAN", taskTitle: s.currentStory || "Paused", taskId: s.currentTaskId });

    const resumeSignalPath = join(projectPath, ".hydra", "resume-signal.json");
    const slowTyping = setInterval(() => { telegram.tg("sendChatAction", { action: "typing" }).catch(() => {}); }, 20000);

    return new Promise((resolve) => {
      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearInterval(slowTyping);
        if (watcher) { try { watcher.close(); } catch {} }
        if (fallbackTimer) clearInterval(fallbackTimer);
      };

      process.once("SIGINT", cleanup);
      process.once("SIGTERM", cleanup);

      const hydraDir = join(projectPath, ".hydra");
      const watcher = watch(hydraDir, (eventType, filename) => {
        if (filename === "resume-signal.json" && (eventType === "change" || eventType === "rename")) {
          try {
            if (!existsSync(resumeSignalPath)) return;
            const sig = JSON.parse(readFileSync(resumeSignalPath, "utf-8"));
            if (sig.resumeAt) {
              cleanup();
              try { unlinkSync(resumeSignalPath); } catch {}
              state.transition("IDLE", { humanGateResolvedAt: new Date().toISOString() });
              resolve("EXEC");
            }
          } catch {}
        }
      });

      const fallbackTimer = setInterval(() => {
        if (existsSync(resumeSignalPath)) {
          try {
            const sig = JSON.parse(readFileSync(resumeSignalPath, "utf-8"));
            if (sig.resumeAt) {
              cleanup();
              try { unlinkSync(resumeSignalPath); } catch {}
              state.transition("IDLE", { humanGateResolvedAt: new Date().toISOString() });
              resolve("EXEC");
            }
          } catch {}
        }
      }, 30000);

      setTimeout(() => {
        if (!resolved) { log("WAIT_HUMAN \u2014 watchdog timeout, forcing cleanup"); cleanup(); resolve("IDLE"); }
      }, 24 * 60 * 60 * 1000);
    });
  }

  // ─── Main loop ───
  log(`\u{1f525} Hydra Loop starting \u2014 ${projectPath}`);
  log(`Checkpoint phase: ${checkpoint.phase} | task: ${checkpoint.currentTaskId || "none"}`);

  let phase = checkpoint.phase || "IDLE";

  while (true) {
    if (safety.isCircuitOpen()) {
      await sendAlert("critical", "Circuit breaker OPEN \u2014 pausing 5 minutes");
      await sleep(5 * 60 * 1000);
      continue;
    }

    try {
      const cmdPath = join(projectPath, ".hydra", "bridge-cmd.json");
      if (existsSync(cmdPath)) {
        const cmdData = JSON.parse(readFileSync(cmdPath, "utf-8"));
        unlinkSync(cmdPath);
        if (cmdData.cmd === "pause") {
          sendAlert("warn", "Loop paused by dashboard command");
          phase = "WAIT_HUMAN";
          state.transition("WAIT_HUMAN", { reason: "Paused by dashboard" });
        } else if (cmdData.cmd === "resume" && phase === "WAIT_HUMAN") {
          sendAlert("info", "Loop resumed by dashboard command");
          phase = "IDLE";
          state.transition("IDLE");
        }
      }
    } catch (e) {
      log(`Error processing bridge command: ${e.message}`);
    }

    switch (phase) {
      case "IDLE": phase = await phaseIDLE(); break;
      case "PLAN": phase = await phasePLAN(); break;
      case "EXEC": phase = await phaseEXEC(); break;
      case "QA": phase = await phaseQA(); break;
      case "COMMIT": phase = await phaseCOMMIT(); break;
      case "REFLECT": phase = await phaseREFLECT(); break;
      case "SYNC": phase = await phaseSYNC(); break;
      case "FIX": phase = await phaseFIX(); break;
      case "DISCOVER": phase = await phaseDISCOVER(); break;
      case "WAIT_HUMAN": phase = await phaseWAIT_HUMAN(); break;
      default: phase = "IDLE";
    }

    memory.appendEvent("heartbeat", { phase });
    try { writeFileSync(join(projectPath, ".hydra", "heartbeat"), JSON.stringify({ phase, ts: Date.now() })); } catch {}

    if (phase === "IDLE") await sleep(5000);
  }
}

main().catch((e) => {
  console.error(`\u{1f4a5} Hydra Loop crashed: ${e.message}`);
  console.error(e.stack);
  try { telegram?.updateStatus?.({ lastError: e.message.slice(0, 200), phase: "CRASHED" }); } catch {}
  process.exit(1);
});
