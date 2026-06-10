#!/usr/bin/env node
/**
 * Agent Runtime — Evolved runner with SSE streaming, stagnation detection,
 * interactive gates, and cost tracking.
 *
 * Learns from:
 *   - OpenHands EventStream + action/observation loop
 *   - opencode-telegram-bot summary aggregator
 *   - Ralph MCP: long-lived agent with memory, stagnation detection
 */

import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";

const OC_URL = process.env.OC_URL || "http://127.0.0.1:4096";
const DEFAULT_TIMEOUT_MS = 900_000; // 15 min per story
const STAGNATION_THRESHOLD = 3;

function now() { return new Date().toISOString(); }

function logErr(projectPath, ctx, err) {
  const logFile = join(projectPath, ".hydra", "runtime-error.log");
  try {
    const entry = `[${now()}] [${ctx}] ${err?.message || String(err)}\n${err?.stack || ''}\n---\n`;
    appendFileSync(logFile, entry);
  } catch {}
  // Also console for systemd journal
  console.error(`[runtime ${ctx}]`, err?.message || err);
}

export class AgentRuntime extends EventEmitter {
  constructor({ projectPath, agentType = "builder", task = null, safety = null } = {}) {
    super();
    this.projectPath = projectPath;
    this.agentType = agentType;
    this.task = task;
    this.safety = safety;
    this.sessionId = null;
    this.sseController = null;
    this.running = false;
    this.costAccumulator = 0;
    this.tokensUsed = 0;
    this.stagnationMap = new Map(); // key: errorFingerprint → count
    this.fileChanges = [];
    this.lastActivityAt = 0;
    this.startedAt = 0;
    this.timedOut = false;
    this._completed = false;
    // Prevent crash from emit("error") after run() resolves
    this.on("error", () => {});
  }

  /* ─── Low-level OpenCode API ─── */

  async api(method, path, opts = {}) {
    const url = `${OC_URL}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": this.projectPath,
          ...opts.headers,
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (!res.ok) {
        this.safety?.recordApiFailure(res.status);
        const text = await res.text().catch(() => "");
        const err = new Error(`[AgentRuntime] ${method} ${path} → HTTP ${res.status}\nBody: ${text.slice(0, 500)}`);
        logErr(this.projectPath, `API.${method}.${path}`, err);
        throw err;
      }
      this.safety?.recordApiSuccess();
      return res.json().catch(() => ({}));
    } catch (fetchErr) {
      // Network-level errors (ECONNREFUSED, timeout, DNS failure, etc.)
      const err = new Error(`[AgentRuntime] ${method} ${path} → ${fetchErr.message || fetchErr}\n(ProjectPath: ${this.projectPath})`);
      logErr(this.projectPath, `API.network.${method}.${path}`, err);
      throw err;
    }
  }

  /* ─── Session lifecycle ─── */

  async createSession() {
    this.safety?.resetSessionCost();
    const title = `${this.agentType} — ${this.task?.title?.slice(0, 60) || "task"} — ${Date.now().toString(36)}`;
    const session = await this.api("POST", "/session", { body: { title } });
    this.sessionId = session.id;
    this.emit("sessionCreated", { sessionId: session.id, title });
    return session.id;
  }

  async abortSession() {
    if (!this.sessionId) return;
    try {
      await this.api("POST", `/session/${this.sessionId}/abort`);
      this.emit("sessionAborted", { sessionId: this.sessionId });
    } catch (e) {
      this.emit("error", e);
    }
    this.sessionId = null;
  }

  /* ─── Prompt builder (Ralph fresh-context) ─── */

  buildPrompt() {
    const progressPath = join(this.projectPath, "progress.txt");
    const bugsPath = join(this.projectPath, "bugs.md");
    const prdPath = join(this.projectPath, "prd.json");
    const agentsGlob = join(this.projectPath, "AGENTS.md");

    const read = (p, limit = 3000) => {
      try { return readFileSync(p, "utf-8").slice(0, limit); } catch { return ""; }
    };

    const progress = read(progressPath, 2500);
    const bugs = read(bugsPath, 1500);
    const prdRaw = read(prdPath, 4000);
    const agents = read(agentsGlob, 2000);

    const systemParts = {
      builder: `You are a Builder implementing ONE user story using SDD.
Context files in this project (read them first):
- CONSTITUTION.md — project principles and constraints
- PRODUCT-SPEC.md — functional requirements
- TECHNICAL-SPEC.md — architecture and tech decisions
- PLAN.md — implementation plan with task details
- prd.json — story list with acceptance criteria

Rules:
1. Read prd.json. Pick the first story where passes: false.
2. Read acceptanceCriteria — those are your EXACT requirements.
3. Look for pre-written test files in the project — run them first (they encode AC).
4. Implement to make tests pass (test-first: red → green → refactor).
5. If no tests exist, write tests first, then implement.
6. Run quality checks (typecheck, test, lint). Fix until all pass.
7. When criteria pass, set passes: true in prd.json.
8. Before committing, read/modify nearby AGENTS.md with reusable patterns.
9. Append to progress.txt (Codebase Patterns section at top; chronological below).
10. Commit with feat(story-#id): title.
11. If ALL stories pass, output <promise>COMPLETE</promise>.
Remember: each run is FRESH. Use files on disk for context.`,

      "bug-hunter": `You are a Bug Hunter. FRESH analysis.
1. Run the app. Test every page/feature.
2. Read ALL code files looking for issues.
3. Append EACH bug found to bugs.md:
   [ ] Description | File:line | Severity (low/medium/high/critical)
4. Append summary to progress.txt.`,

      innovator: `You are an Innovator. FRESH ideation.
1. Read all code, run the app, explore every feature.
2. Propose NEW ideas appended to ideas.md:
   [ ] Idea | Description | Impact | Effort
3. Append top 3 recommendations to progress.txt.`,

      orchestrator: `You are the Orchestrator. Maintain prd.json from bugs.md and ideas.md.
Deduplicate: if a story with similar title exists, SKIP it.
Add acceptanceCriteria to new stories.
Reorder by priority: 1 critical → 4 low.
Never delete existing stories.`,

      "project-planner": `You are a Project Planner using SDD (Spec-Driven Development).
A new project is starting with NO code yet. Design the complete implementation roadmap.

Read project title and description from ideas.md (or directory name).
Create these files in the project directory:

1. CONSTITUTION.md — Immutable principles:
   - Tech stack non-negotiables (language, framework, database, testing)
   - Coding conventions and patterns
   - Architecture constraints
   - Quality gates (typecheck, test, lint)

2. PRODUCT-SPEC.md — Functional specification:
   - User personas and core journeys
   - Feature list with acceptance criteria
   - What the system does (not how)

3. TECHNICAL-SPEC.md — Technical specification:
   - Tech stack decisions with rationale
   - Architecture overview (ASCII diagram ok)
   - Data models and schemas
   - API contracts and interfaces
   - File tree structure

4. PLAN.md — Implementation plan:
   - Tasks: 3-12 ordered implementation steps from init to MVP
   - Each task: title, description, files changed, AC (3-5 per task), dependencies
   - Identify parallelizable tasks
   - Task 1 MUST be project setup (init, config, deps, CI)

5. Update prd.json:
   - codebasePatterns: condensed summary of tech+arch decisions
   - stories: map 1:1 to PLAN.md tasks

Also append to progress.txt: summary of all decisions made.`,

      "task-planner": `You are a Task Planner using SDD (Spec-Driven Development) for ONE task.
Your job: prepare a task for implementation by writing specs and tests.

Read the project directory:
- CONSTITUTION.md — project principles to follow
- PRODUCT-SPEC.md — functional context
- TECHNICAL-SPEC.md — architecture and tech stack
- PLAN.md — full implementation plan
- prd.json — story list

The current task is described in the task context. Do:
1. Write test files that encode the task's acceptance criteria as runnable tests
   - Follow the project's test framework (from CONSTITUTION.md or package.json)
   - Start with the test that captures the core behavior
2. Update PLAN.md with task-specific implementation details
3. Append task prerequisites and notes to progress.txt

IMPORTANT: Tests MUST exist before builder runs. Write real, runnable tests.`,

      "skill-extractor": `You are a Skill Extractor. You analyze the code changes made in a git diff to extract generalized, reusable rules, gotchas, or design patterns (skills) for future builder runs.
Instructions:
1. Carefully analyze the provided git diff.
2. If the change is trivial (e.g. only adding comments, changing a single config line, formatting), output exactly: NO_SKILL
3. Otherwise, write a generalized markdown documentation for this skill.
4. The skill documentation MUST follow this format:
   # [Skill Title - descriptive name of the pattern/integration]
   
   ## Context
   [Briefly explain when this pattern is applicable]
   
   ## Pattern / Best Practice
   [Explain the rules, conventions, or design decisions to follow]
   
   ## Gotchas / Troubleshooting
   [Describe edge cases, common bugs, or setup details to watch out for]
   
5. Keep it concise, focused on reusable technical patterns, and language-independent where possible.
6. Do NOT include story-specific details, commit hashes, or author information.`,

      "summarizer": `You are a Log Summarizer. Your job is to condense a long stream of system event logs into a dense, high-level summary (MemGPT style) to preserve context while reducing token usage.
Instructions:
1. Read the provided chronological list of events.
2. Group related events (e.g. multiple retries, builder attempts, or successive QA gates).
3. Produce a concise, bulleted markdown summary of:
   - Completed features and stories.
   - Blocked tasks and the exact reasons they failed.
   - Discovered bugs or ideas.
   - Significant system status changes.
4. Output only the summarized markdown content. Do not include introductory or concluding text.`,
    };

    const system = systemParts[this.agentType] || systemParts.builder;

    const context = [
      `## System\n${system}`,
      `## Task\n${this.task?.title || "No specific task"}`,
      this.task?.description ? `Description: ${this.task.description}` : "",
      this.task?.acceptanceCriteria?.length
        ? `Acceptance Criteria:\n${this.task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
        : "",
      `## progress.txt (top)\n${progress}`,
      `## bugs.md\n${bugs}`,
      `## AGENTS.md\n${agents}`,
      `## prd.json (excerpt)\n${prdRaw.slice(0, 2000)}`,
      `## Project Path\n${this.projectPath}`,
      `\nBegin work now. Be minimal. Be correct.`,
    ].filter(Boolean).join("\n\n");

    return context;
  }

  /* ─── Execution with SSE ─── */

  async run(timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.running) throw new Error("Runtime already running");
    this.running = true;
    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.timedOut = false;
    this.costAccumulator = 0;
    this.tokensUsed = 0;
    this.fileChanges = [];
    this.stagnationMap.clear();
    this._completed = false;

    await this.createSession();

    // Send prompt and capture the response — it contains the assistant message inline
    const prompt = this.buildPrompt();
    let postResult;
    try {
      postResult = await this.api("POST", `/session/${this.sessionId}/message`, {
        body: { parts: [{ type: "text", text: prompt }] },
      });
    } catch (e) {
      // POST failed — let the poll timer or timeout handle recovery
      postResult = null;
    }

    // Start SSE after sending prompt to avoid race with session creation
    this._subscribeSSE();

    // If POST returned inline completion, mark early but still wait for SSE confirm
    if (postResult) {
      const completed = postResult?.info?.time?.completed;
      if (completed) {
        this._completed = true;
        // Still allow SSE to finalize before returning
        await new Promise(r => setTimeout(r, 2000));
        return Promise.resolve({ ok: true, sessionId: this.sessionId, cost: postResult?.info?.cost || 0, elapsedMs: Date.now() - this.startedAt });
      }
      // POST returned but no completion — DO NOT return ok:true.
      // The API is async; we must wait for SSE/poll to confirm completion.
      // Fall through to the poll/event wait below.
    }

    // Fallback: poll for completion (SSE or message-based)
    let pollingStartsAt = Date.now();
    let pollTimer = setInterval(async () => {
      if (this._completed) return;
      try {
        const msgs = await this.api("GET", `/session/${this.sessionId}/message?role=assistant&limit=3`);
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            if (m.info?.time?.completed) {
              clearInterval(pollTimer);
              this._maybeComplete();
              return;
            }
          }
        }
        // If after 120s no assistant message, assume completion (POST may have succeeded without persistence)
        if (Date.now() - pollingStartsAt > 120000) {
          clearInterval(pollTimer);
          this._maybeComplete();
          return;
        }
      } catch {}
    }, 3000);

    // Timeout guard
    const timeoutTimer = setTimeout(() => {
      this.timedOut = true;
      clearInterval(pollTimer);
      this.emit("timeout", { sessionId: this.sessionId, elapsedMs: Date.now() - this.startedAt });
      this._cleanup();
    }, timeoutMs);

    // Activity heartbeat (stall detection)
    const stallTimer = setInterval(() => {
      const idle = Date.now() - this.lastActivityAt;
      if (idle > 300_000) {
        this.emit("stallWarning", { idleMs: idle, sessionId: this.sessionId });
      }
    }, 60_000);

    // Wait for completion or error
    return new Promise((resolve) => {
      // Race guard: already completed before Promise setup
      if (this._completed) {
        clearTimeout(timeoutTimer);
        clearInterval(stallTimer);
        clearInterval(pollTimer);
        return resolve({ ok: true, sessionId: this.sessionId, cost: this.costAccumulator, elapsedMs: Date.now() - this.startedAt });
      }
      this.once("completed", (data) => {
        clearTimeout(timeoutTimer);
        clearInterval(stallTimer);
        clearInterval(pollTimer);
        resolve({ ok: true, ...data });
      });
      this.once("runtimeError", (err) => {
        clearTimeout(timeoutTimer);
        clearInterval(stallTimer);
        clearInterval(pollTimer);
        resolve({ ok: false, error: err.message || String(err) });
      });
      this.once("timeout", () => {
        clearTimeout(timeoutTimer);
        clearInterval(stallTimer);
        clearInterval(pollTimer);
        resolve({ ok: false, error: "TIMEOUT", timedOut: true });
      });
      this.once("humanRequired", (data) => {
        clearTimeout(timeoutTimer);
        clearInterval(stallTimer);
        clearInterval(pollTimer);
        resolve({ ok: false, humanRequired: true, ...data });
      });
      this.once("stagnation", (data) => {
        clearTimeout(timeoutTimer);
        clearInterval(stallTimer);
        clearInterval(pollTimer);
        resolve({ ok: false, error: `STAGNATION: ${data.message}` });
      });
    });
  }

  /* ─── SSE parsing ─── */

  _subscribeSSE() {
    if (this.sseController) this.sseController.abort();
    this.sseController = new AbortController();

    const url = `${OC_URL}/global/event`;
    fetch(url, {
      headers: {
        "x-opencode-directory": this.projectPath,
        Accept: "text/event-stream",
      },
      signal: this.sseController.signal,
    }).then(async (res) => {
      if (!res.ok) {
        this.emit("error", new Error(`SSE ${res.status}`));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const ev = JSON.parse(line.slice(6));
              this._processEvent(ev);
            } catch {}
          }
        }
      }
    }).catch((err) => {
      if (err.name !== "AbortError") {
        const msg = `SSE fatal error: ${err.message || err}`;
        logErr(this.projectPath, "SSE.subscribe", new Error(msg));
        this.emit("error", new Error(msg));
      }
    }).finally(() => {
      // SSE stream ended — if not completed yet, check one more time
      if (this.running && !this._completed) {
        this.api("GET", `/session/${this.sessionId}/message?role=assistant&limit=3`).then(msgs => {
          if (Array.isArray(msgs) && msgs.some(m => m.info?.time?.completed)) {
            this._completed = true;
            this._maybeComplete();
          }
        }).catch(() => {});
      }
    });
  }

  _processEvent(ev) {
    this.lastActivityAt = Date.now();
    const type = ev.type || ev.event || "";

    // Thinking / reasoning
    if (type === "message.part.updated" && ev.properties?.part?.type === "reasoning") {
      this.emit("thinking", { sessionId: this.sessionId });
    }

    // Tool call
    if (type === "message.part.updated" && ev.properties?.part?.type === "tool") {
      const tool = ev.properties.part.tool;
      const title = ev.properties.part.state?.title || tool;
      this.emit("toolCall", { sessionId: this.sessionId, tool, title });
    }

    // File changes
    if (type === "session.diff" && Array.isArray(ev.properties?.diffs)) {
      for (const d of ev.properties.diffs) {
        this.fileChanges.push(d);
      }
      this.emit("filesChanged", this.fileChanges);
    }

    // Tokens / cost
    if (type === "message.updated" && ev.properties?.info?.role === "assistant") {
      const info = ev.properties.info;
      if (info.tokens) {
        const t = info.tokens;
        this.tokensUsed = (t.input || 0) + (t.output || 0) + (t.cache?.read || 0);
      }
      if (typeof info.cost === "number") {
        this.costAccumulator += info.cost;
        this.emit("cost", { cost: this.costAccumulator, sessionId: this.sessionId });
      }

      // Completion check
      if (info.time?.completed) {
        this._maybeComplete();
      }
    }

    // Human-in-the-loop gates — auto-approved (LLM has full PC access)
    // The agent can run any command, read/write any file. Questions/permissions
    // are false positives — the agent should resolve them autonomously.
    if (type === "permission.asked" && ev.properties?.id) {
      const permissionID = ev.properties.id;
      this.emit("log", { level: "info", message: `Auto-approving permission: ${permissionID}` });
      this.api("POST", `/session/${this.sessionId}/permissions/${permissionID}`, {
        body: { response: "always" }
      }).catch(err => {
        logErr(this.projectPath, "auto-approve-permission", err);
      });
      return;
    }

    if (type === "question.asked" || type === "permission.asked") {
      // Log for debugging, but let the agent continue — no cleanup, no halt
      this.emit("log", { level: "info", message: `Auto-approved ${type} (${ev.properties?.id})` });
      return;
    }

    // Error handling
    if (type === "session.error") {
      const msg = ev.properties?.status?.message || "Unknown session error";
      this._recordError(msg);
    }

    // Retry events
    if (type === "session.status" && ev.properties?.status?.type === "retry") {
      const msg = ev.properties.status.message || "retry";
      this._recordError(msg);
    }
  }

  async _maybeComplete() {
    if (this._completed) return;
    this._completed = true;

    let content = "";
    try {
      const msgs = await this.api("GET", `/session/${this.sessionId}/message?role=assistant&limit=1`);
      if (Array.isArray(msgs) && msgs.length > 0) {
        const lastMsg = msgs[0];
        if (lastMsg.parts && Array.isArray(lastMsg.parts)) {
          content = lastMsg.parts.map(p => typeof p === 'string' ? p : (p.text || '')).join('');
        } else if (typeof lastMsg.content === 'string') {
          content = lastMsg.content;
        } else if (lastMsg.text && typeof lastMsg.text === 'string') {
          content = lastMsg.text;
        } else if (lastMsg.info?.content && typeof lastMsg.info.content === 'string') {
          content = lastMsg.info.content;
        }
      }
    } catch (err) {
      // Non-fatal error during content retrieval
    }

    // Check prd.json for COMPLETE signal or stagnation
    try {
      const prd = JSON.parse(readFileSync(join(this.projectPath, "prd.json"), "utf-8"));
      const allDone = prd.stories?.every?.((s) => s.passes) ?? false;
      this.emit("completed", {
        sessionId: this.sessionId,
        allDone,
        cost: this.costAccumulator,
        fileChanges: this.fileChanges,
        elapsedMs: Date.now() - this.startedAt,
        content,
        result: { info: { content } },
      });
      this._cleanup();
    } catch {
      // If prd.json unreadable, just mark completed on message.updated
      this.emit("completed", {
        sessionId: this.sessionId,
        cost: this.costAccumulator,
        content,
        result: { info: { content } },
      });
      this._cleanup();
    }
  }

  _maybeCompleteFromResponse(postResult) {
    if (this._completed) return;
    this._completed = true;

    let content = "";
    if (postResult) {
      if (postResult.parts && Array.isArray(postResult.parts)) {
        content = postResult.parts.map(p => typeof p === 'string' ? p : (p.text || '')).join('');
      } else if (typeof postResult.content === 'string') {
        content = postResult.content;
      } else if (postResult.text && typeof postResult.text === 'string') {
        content = postResult.text;
      } else if (postResult.info?.content && typeof postResult.info.content === 'string') {
        content = postResult.info.content;
      }
    }

    const cost = this.costAccumulator || postResult?.info?.cost || 0;
    this.emit("completed", {
      sessionId: this.sessionId,
      allDone: false,
      cost,
      fileChanges: this.fileChanges,
      elapsedMs: Date.now() - this.startedAt,
      content,
      result: postResult || { info: { content } },
    });
    this._cleanup();
  }

  /* ─── Stagnation detection ─── */

  _recordError(msg) {
    if (!this.running) return;
    const err = new Error(`Stagnation/Retry: ${msg}`);
    logErr(this.projectPath, "stagnation", err);
    const key = msg.toLowerCase().slice(0, 120); // fingerprint
    const prev = this.stagnationMap.get(key) || 0;
    const next = prev + 1;
    this.stagnationMap.set(key, next);

    if (next >= STAGNATION_THRESHOLD) {
      this.emit("stagnation", {
        message: msg,
        occurrences: next,
        sessionId: this.sessionId,
      });
      this._cleanup();
    } else {
      this._cleanup();
      this.emit("runtimeError", new Error(msg));
    }
  }

  /* ─── Cleanup ─── */

  _cleanup() {
    this.running = false;
    if (this.sseController) {
      this.sseController.abort();
      this.sseController = null;
    }
  }

  stop() {
    this._cleanup();
    this.abortSession();
  }
}

export default AgentRuntime;
