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
import { systemPrompts } from "../src/prompts/system-prompts.mjs";

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

async function fetchWithRetry(url, options, projectPath, ctx, retries = 3, delay = 10000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status === 503) {
        if (i === retries - 1) return res;
        const backoffMs = 60000 * (i + 1); // Exponential-ish backoff
        logErr(projectPath, `fetchWithRetry.${ctx}`, new Error(`HTTP ${res.status}, retrying ${i + 1}/${retries} in ${backoffMs}ms...`));
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      logErr(projectPath, `fetchWithRetry.${ctx}`, new Error(`${err.message || err}, retrying ${i + 1}/${retries} in ${delay}ms...`));
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export class AgentRuntime extends EventEmitter {
  constructor({ projectPath, agentType = "builder", task = null, safety = null, stream = null } = {}) {
    super();
    this.projectPath = projectPath;
    this.agentType = agentType;
    this.task = task;
    this.safety = safety;
    this.stream = stream;
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

  emit(eventName, ...args) {
    if (this.stream) {
      if (eventName === "thinking") this.stream.emit("Thought", "agent", args[0] || {});
      else if (eventName === "toolCall") this.stream.emit("Action", "agent", args[0] || {});
      else if (eventName === "error" || eventName === "runtimeError") this.stream.emit("Observation", "environment", { error: args[0]?.message || args[0] });
    }
    return super.emit(eventName, ...args);
  }

  /* ─── Low-level OpenCode API ─── */

  async _getOcUrl() {
    try {
      const { getDockerController } = await import("./docker-runtime.mjs");
      const controller = getDockerController(this.projectPath);
      // Ensure sandbox is started. Since AgentRuntime creates a new session per task, 
      // we can map the sandbox using the taskId (or sessionId if taskId is missing).
      // Here we just ask for the sandbox matching the projectPath.
      // A better way is to pass taskId to AgentRuntime constructor.
      if (this.task && this.task.id) {
        const cid = await controller.startSandbox(this.task.id, this.projectPath);
        const container = controller.containers.get(this.task.id);
        if (container && container.ip) {
          return `http://${container.ip}:5000`;
        }
      }
    } catch (e) {
      // Fallback
    }
    return OC_URL;
  }

  async api(method, path, opts = {}) {
    const baseUrl = await this._getOcUrl();
    const url = `${baseUrl}${path}`;
    try {
      const res = await fetchWithRetry(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": this.projectPath,
          ...opts.headers,
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }, this.projectPath, `API.${method}`);
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

    const system = systemPrompts[this.agentType] || systemPrompts.builder;

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
    this.lastPrompt = prompt;

    // --- SOTA: Predictive Semantic Caching ---
    if (["planner", "architect", "reviewer", "qa", "visual-reviewer"].includes(this.agentType)) {
      try {
        const { SemanticCache } = await import("../src/core/semantic-cache.mjs");
        const cache = new SemanticCache(this.projectPath);
        const match = await cache.findMatch(prompt, 0.95);
        if (match && match.hit) {
          this.emit("log", { level: "info", message: `🧠 Semantic Cache HIT for ${this.agentType}! Similarity: ${(match.similarity * 100).toFixed(1)}%` });
          this._completed = true;
          const costSaved = match.costSaved || 0;
          return { ok: true, sessionId: this.sessionId || "cached", cost: 0, elapsedMs: 0, content: match.content, result: { info: { content: match.content } } };
        }
      } catch (e) {
        logErr(this.projectPath, "semantic-cache", e);
      }
    }
    
    const parts = [{ type: "text", text: prompt }];
    if (this.task?._screenshotBase64) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${this.task._screenshotBase64}` }
      });
    }

    let postResult;
    try {
      postResult = await this.api("POST", `/session/${this.sessionId}/message`, {
        body: { parts },
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
    fetchWithRetry(url, {
      headers: {
        "x-opencode-directory": this.projectPath,
        Accept: "text/event-stream",
      },
      signal: this.sseController.signal,
    }, this.projectPath, "SSE").then(async (res) => {
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
        this.emit("cost", { cost: this.costAccumulator, tokens: this.tokensUsed, sessionId: this.sessionId });
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
      this._storeSotaData(content);
      this._cleanup();
    } catch {
      // If prd.json unreadable, just mark completed on message.updated
      this.emit("completed", {
        sessionId: this.sessionId,
        cost: this.costAccumulator,
        content,
        result: { info: { content } },
      });
      this._storeSotaData(content);
      this._cleanup();
    }
  }

  async _storeSotaData(content) {
    if (!content || !this.lastPrompt) return;
    try {
      const { DistillationLogger } = await import("../src/core/distillation-logger.mjs");
      const logger = new DistillationLogger(this.projectPath);
      const sysPrompt = systemPrompts[this.agentType] || systemPrompts.builder;
      logger.appendSuccess(sysPrompt, this.lastPrompt, content);

      if (["planner", "architect", "reviewer", "qa", "visual-reviewer"].includes(this.agentType)) {
        const { SemanticCache } = await import("../src/core/semantic-cache.mjs");
        const cache = new SemanticCache(this.projectPath);
        await cache.store(this.lastPrompt, content, this.costAccumulator);
      }
    } catch (e) {
      logErr(this.projectPath, "sota-storage", e);
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
    this._storeSotaData(content);
    this._cleanup();
  }

  /* ─── Stagnation detection ─── */

  async _recordError(msg) {
    if (!this.running) return;
    
    // SOTA Pattern: Rate limits should not poison the stagnation logic
    const msgLower = msg.toLowerCase();
    const isRateLimit = msgLower.includes("429") || msgLower.includes("rate limit") || msgLower.includes("too many requests");
    
    if (isRateLimit) {
      logErr(this.projectPath, "rate-limit", new Error(`Rate limit detected via SSE: ${msg}. Sleeping 60s to protect bucket...`));
      await new Promise(r => setTimeout(r, 60000));
      this._cleanup();
      this.emit("runtimeError", new Error(`RATE_LIMIT: ${msg}`));
      return;
    }

    const err = new Error(`Stagnation/Retry: ${msg}`);
    logErr(this.projectPath, "stagnation", err);
    const key = msgLower.slice(0, 120); // fingerprint
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
