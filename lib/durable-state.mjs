#!/usr/bin/env node
/**
 * Durable State Manager
 * Atomic checkpoint / resume for the 24/7 loop.
 *
 * Inspired by:
 *   - OpenHands event-sourced state model (crash recovery < 20ms)
 *   - Temporal deterministic replay ( checkpoints are the only truth )
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const CHECKPOINT_FILE = "loop-checkpoint.json";
const BACKUP_FILE = "loop-checkpoint.json.bak";

export class DurableStateManager {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.dir = join(projectPath, ".hydra");
    this.cpPath = join(this.dir, CHECKPOINT_FILE);
    this.bakPath = join(this.dir, BACKUP_FILE);
    this._state = null;
    this._version = 1;
    this._saveTimer = null;

    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /* ─── Core I/O ─── */

  load() {
    try {
      if (existsSync(this.cpPath)) {
        const raw = readFileSync(this.cpPath, "utf-8");
        const parsed = JSON.parse(raw);
        this._state = parsed;
        this._version = parsed.version || 1;
        return parsed;
      }
    } catch (e) {
      console.error("[DurableState] load error:", e.message);
    }

    // First run — create baseline
    const baseline = this._baseline();
    this.save(baseline);
    this._state = baseline;
    return baseline;
  }

  save(override = null) {
    const state = override || this._state;
    if (!state) return false;

    state.version = this._version;
    state.updatedAt = new Date().toISOString();

    const json = JSON.stringify(state, null, 2);

    // Atomic write: write tmp → rename
    const tmp = this.cpPath + ".tmp" + Date.now();
    try {
      writeFileSync(tmp, json, "utf-8");
      renameSync(tmp, this.cpPath);
      // Remove old backup after successful write
      try { if (existsSync(this.bakPath)) unlinkSync(this.bakPath); } catch {}
      return true;
    } catch (e) {
      console.error("[DurableState] save error:", e.message);
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
      return false;
    }
  }

  _debouncedSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 1000);
  }

  transition(phase, extra = {}) {
    if (!this._state) this.load();
    const prev = this._state.phase;
    this._state.phase = phase;
    this._state.lastPhase = prev;
    Object.assign(this._state, extra);
    this._state.eventId = (this._state.eventId || 0) + 1;
    this.save();
    return this._state;
  }

  /* ─── Helpers ─── */

  get() { return this._state; }

  _baseline() {
    return {
      version: this._version,
      projectPath: this.projectPath,
      phase: "IDLE",
      lastPhase: null,
      currentTaskId: null,
      currentStory: null,
      attempt: 0,
      maxAttempts: Number(process.env.LOOP_MAX_ATTEMPTS) || 3,
      previousError: null,
      humanGateReason: null,
      humanGateResolvedAt: null,
      eventId: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      costAccumulatorUsd: 0,
      storiesCompletedToday: 0,
    };
  }
}

// Singleton helper
const instances = new Map();
export function getDurableState(projectPath) {
  if (!instances.has(projectPath)) instances.set(projectPath, new DurableStateManager(projectPath));
  return instances.get(projectPath);
}
