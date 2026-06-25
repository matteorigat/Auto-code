#!/usr/bin/env node
/**
 * Durable State Manager
 * Atomic checkpoint / resume for the 24/7 loop.
 *
 * Inspired by:
 *   - OpenHands event-sourced state model (crash recovery < 20ms)
 *   - Temporal deterministic replay ( checkpoints are the only truth )
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import config from '../config/index.mjs';
import { FileLocker } from './file-locker.mjs';

const CHECKPOINT_FILE = 'loop-checkpoint.json';
const BACKUP_FILE = 'loop-checkpoint.json.bak';

export class DurableStateManager {
  /**
   * Initializes durable state
   * @param {string} projectPath
   * @param {import("./event-stream.mjs").EventStream} stream
   */
  constructor(projectPath, stream) {
    this.projectPath = projectPath;
    this.dir = join(projectPath, '.hydra');
    this.cpPath = join(this.dir, CHECKPOINT_FILE);
    this.bakPath = join(this.dir, BACKUP_FILE);
    this._state = null;
    this._version = 1;
    this._saveTimer = null;
    this.stream = stream;
    this.locker = new FileLocker(projectPath);

    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /* ─── Core I/O ─── */

  async load() {
    return this.locker.withLock('durable-state', async () => {
      try {
        if (existsSync(this.cpPath)) {
          const raw = readFileSync(this.cpPath, 'utf-8');
          const parsed = JSON.parse(raw);
          this._state = parsed;
          this._version = parsed.version || 1;
          return parsed;
        }
      } catch (e) {
        console.error('[DurableState] load error:', e.message);
      }

      // First run — create baseline
      const baseline = this._baseline();
      this.saveSync(baseline);
      this._state = baseline;
      return baseline;
    });
  }

  saveSync(override = null) {
    const state = override || this._state;
    if (!state) return false;

    state.version = this._version;
    state.updatedAt = new Date().toISOString();

    const json = JSON.stringify(state, null, 2);

    // Atomic write: write tmp → rename
    const tmp = this.cpPath + '.tmp' + Date.now();
    try {
      writeFileSync(tmp, json, 'utf-8');
      renameSync(tmp, this.cpPath);
      // Remove old backup after successful write
      try {
        if (existsSync(this.bakPath)) unlinkSync(this.bakPath);
      } catch {
        /* intentional: best-effort cleanup */
      }
      return true;
    } catch (e) {
      console.error('[DurableState] save error:', e.message);
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* intentional: best-effort cleanup */
      }
      return false;
    }
  }

  async save(override = null) {
    return this.locker.withLock('durable-state', async () => {
      return this.saveSync(override);
    });
  }

  async transition(phase, extra = {}) {
    if (!this._state) await this.load();
    const prev = this._state.phase;
    this._state.phase = phase;
    this._state.lastPhase = prev;
    Object.assign(this._state, extra);
    this._state.eventId = (this._state.eventId || 0) + 1;
    await this.save();
    return this._state;
  }

  /* ─── Helpers ─── */

  /**
   * Retrieves the entire state object.
   * @returns {Object}
   */
  get() {
    return this._state;
  }

  /**
   * Update state and broadcast
   * @param {string} key
   * @param {any} val
   */
  set(key, val) {
    if (!this._state) this.load();
    this._state[key] = val;
    this.save();
    if (this.stream) this.stream.emit('state-update', { key, val });
  }

  _baseline() {
    return {
      version: this._version,
      projectPath: this.projectPath,
      phase: 'IDLE',
      lastPhase: null,
      currentTaskId: null,
      currentStory: null,
      attempt: 0,
      maxAttempts: config.loop.maxAttempts,
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
