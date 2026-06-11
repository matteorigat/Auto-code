#!/usr/bin/env node
/**
 * Memory Manager — Structured progress, patterns DB, event stream
 *
 * Learns from Ralph (progress.txt, AGENTS.md) and OpenHands (EventStream)
 * with compaction support.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

export class MemoryManager {
  constructor(projectPath, stream = null) {
    this.projectPath = projectPath;
    this.stream = stream;
    this.hydraDir = join(projectPath, ".hydra");
    if (!existsSync(this.hydraDir)) mkdirSync(this.hydraDir, { recursive: true });
    this.jsonlPath = join(this.hydraDir, "event-stream.jsonl");
    this.patternsPath = join(this.hydraDir, "patterns.json");
    this.progressPath = join(projectPath, "progress.txt");
    this._ensureFiles();
  }

  _ensureFiles() {
    if (!existsSync(this.jsonlPath)) writeFileSync(this.jsonlPath, "", "utf-8");
    if (!existsSync(this.patternsPath)) writeFileSync(this.patternsPath, JSON.stringify([]), "utf-8");
    if (!existsSync(this.progressPath)) {
      writeFileSync(this.progressPath, `# Progress Log\n\n## Codebase Patterns\n(Add reusable patterns here)\n\n---\n\n## Chronological Log\n\n`, "utf-8");
    }
  }

  /* ─── Structured Event Stream ─── */

  appendEvent(type, payload = {}) {
    if (this.stream) {
      this.stream.emit(type, "system", payload);
    } else {
      const line = JSON.stringify({ ts: Date.now(), type, payload });
      try {
        writeFileSync(this.jsonlPath, line + "\n", { flag: "a" });
      } catch {}
    }
  }

  readEvents(since = 0) {
    try {
      return readFileSync(this.jsonlPath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => {
          const t = e.ts || (e.timestamp ? new Date(e.timestamp).getTime() : 0);
          return t >= since;
        });
    } catch { return []; }
  }

  readRecentEvents(n = 10) {
    try {
      const lines = readFileSync(this.jsonlPath, "utf-8")
        .split("\n")
        .filter(Boolean);
      return lines.slice(-n).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  /* ─── Patterns DB (JSON array, simple but RAG-ready) ─── */

  loadPatterns() {
    try {
      return JSON.parse(readFileSync(this.patternsPath, "utf-8"));
    } catch { return []; }
  }

  savePatterns(list) {
    writeFileSync(this.patternsPath, JSON.stringify(list, null, 2));
  }

  addPattern(text, meta = {}) {
    const patterns = this.loadPatterns();
    // Deduplicate by simplified text
    const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (patterns.some((p) => p._norm === norm)) return false;
    patterns.unshift({
      _norm: norm,
      text,
      directory: meta.directory || "",
      sourceStory: meta.storyId || "",
      createdAt: new Date().toISOString(),
    });
    // Keep max 200 patterns (oldest dropped)
    while (patterns.length > 200) patterns.pop();
    this.savePatterns(patterns);
    return true;
  }

  getPatternsSnippet() {
    return this.loadPatterns()
      .slice(0, 30)
      .map((p) => `- ${p.text}`)
      .join("\n");
  }

  /* ─── progress.txt compatibility ─── */

  appendProgress(entry) {
    const header = `## ${new Date().toISOString()} — ${entry.phase || "entry"}\n`;
    const body = [
      entry.taskId ? `- Task: ${entry.taskId}` : null,
      entry.summary ? `- Summary: ${entry.summary}` : null,
      entry.learnings ? `- Learnings:\n${entry.learnings.map((l) => `  - ${l}`).join("\n")}` : null,
      entry.qa ? `- QA: ${entry.qa}` : null,
      entry.cost ? `- Cost: $${entry.cost.toFixed(2)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const block = `${header}${body}\n---\n`;
    try {
      const current = readFileSync(this.progressPath, "utf-8");
      writeFileSync(this.progressPath, current + block, "utf-8");
    } catch {}
    this.appendEvent("progressAppended", { taskId: entry.taskId, summary: entry.summary });
  }

  /* ─── Compaction (rotate when > 50MB, keep last 3 backups) ─── */

  needsCompaction() {
    try {
      const st = statSync(this.jsonlPath);
      return st.size > 50 * 1024 * 1024;
    } catch { return false; }
  }

  async compact(summarizerCallback) {
    let summaryText = "";
    if (typeof summarizerCallback === "function") {
      try {
        const runtime = summarizerCallback();
        if (runtime) {
          const events = this.readRecentEvents(100);
          runtime.task = {
            title: "Summarize event stream log",
            description: JSON.stringify(events, null, 2),
          };
          const res = await runtime.run(180000);
          if (res.ok) {
            summaryText = res.content || res.result?.info?.content || "";
          }
        }
      } catch (err) {
        console.error("[MemoryManager] Semantic compaction summarization failed:", err.message);
      }
    }

    try {
      if (!existsSync(this.jsonlPath)) return true;
      for (let i = 2; i >= 0; i--) {
        const src = i === 0 ? this.jsonlPath : this.jsonlPath + "." + i;
        const dst = this.jsonlPath + "." + (i + 1);
        if (existsSync(src)) {
          renameSync(src, dst);
        }
      }
      writeFileSync(this.jsonlPath, "", "utf-8");
      this.appendEvent("compactionDone", { sizeMb: 50, keptBackups: 3 });
      if (summaryText) {
        this.appendEvent("compactionSummary", { summary: summaryText });
      }
      return true;
    } catch {
      this.appendEvent("compactionFailed", {});
      return false;
    }
  }
}

export default MemoryManager;
