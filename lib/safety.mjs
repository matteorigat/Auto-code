#!/usr/bin/env node
/**
 * Safety — Circuit breaker, cost guard, git snapshot, guardrails
 *
 * Inspired by OpenHands Security Analyzer + Temporal idempotency.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COST_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_COST = 10; // USD
const DEFAULT_MAX_CYCLE_MIN = 30;

export class Safety {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this._costLog = this._loadCostLog();
    this._modelHealth = { failures: 0, lastFailure: 0 };
    this._circuitOpen = false;
    this._lastCost = 0; // Track last cost to calculate deltas
  }

  _costLogPath() {
    return join(this.projectPath, ".hydra", "cost-log.json");
  }

  _loadCostLog() {
    try {
      return JSON.parse(readFileSync(this._costLogPath(), "utf-8"));
    } catch {
      return [];
    }
  }

  _saveCostLog() {
    try {
      writeFileSync(this._costLogPath(), JSON.stringify(this._costLog));
    } catch {}
  }

  /* ─── Git snapshot (rollback target) ─── */

  snapshotBeforeWork(storyId, cwd = null) {
    try {
      execSync(`git add -A && git stash push -m "hydra-pre-${storyId}-${Date.now()}"`, {
        cwd: cwd || this.projectPath,
        shell: "/bin/bash",
        timeout: 15000,
      });
      return true;
    } catch {
      return false;
    }
  }

  rollbackLastSnapshot(storyId, cwd = null) {
    const targetDir = cwd || this.projectPath;
    try {
      // 1. Wipe all failed, dirty, and untracked changes
      try {
        execSync("git reset --hard HEAD && git clean -fd", { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });
      } catch (err) {
        console.error(`[Safety] reset/clean failed: ${err.message}`);
      }

      // 2. Safely pop the pre-work stash if one was created
      const stashes = execSync("git stash list", { cwd: targetDir, encoding: "utf-8" }).toString();
      const escaped = storyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = stashes.match(new RegExp(`(stash@\\{\\d+\\}):.*hydra-pre-${escaped}`));
      if (match) {
        execSync(`git stash pop ${match[1]}`, { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });
        return true;
      }
      return true;
    } catch (e) {
      console.error(`[Safety] rollback failed for ${storyId}:`, e.message);
    }
    return false;
  }

  /* ─── Cost guard ─── */

  resetSessionCost() {
    this._lastCost = 0;
  }

  resetCostWindow() {
    const cutoff = Date.now() - COST_WINDOW_MS;
    this._costLog = this._costLog.filter((e) => e.at > cutoff);
  }

  /**
   * Add cost increment to the log.
   * 
   * FIX: Previously this method was called with the full accumulator value
   * from AgentRuntime (costAccumulator), causing the total to be added 
   * repeatedly. Now we track the last seen cost and only log the delta.
   * 
   * @param {number} usd - Total cost accumulator from this session
   */
  addCost(usd) {
    this.resetCostWindow();
    const delta = Math.max(0, usd - this._lastCost);
    this._lastCost = usd;
    if (delta > 0) {
      this._costLog.push({ at: Date.now(), cost: delta });
      this._saveCostLog();
    }
  }

  getDailyCost() {
    this.resetCostWindow();
    return this._costLog.reduce((sum, e) => sum + e.cost, 0);
  }

  isOverBudget() {
    const raw = process.env.LOOP_DAILY_COST_LIMIT || process.env.LOOP_MAX_COST_PER_DAY_USD;
    const max = raw ? Number(raw) : DEFAULT_MAX_COST;
    if (isNaN(max) || max <= 0) return this.getDailyCost() >= DEFAULT_MAX_COST;
    return this.getDailyCost() >= max;
  }

  /* ─── Circuit breaker for LLM API ─── */

  recordApiFailure(statusCode) {
    if (statusCode >= 500 || statusCode === 429) {
      this._modelHealth.failures++;
      this._modelHealth.lastFailure = Date.now();
    }
    if (this._modelHealth.failures >= 3) {
      this._circuitOpen = true;
    }
  }

  recordApiSuccess() {
    this._modelHealth.failures = Math.max(0, this._modelHealth.failures - 1);
    if (this._modelHealth.failures === 0) this._circuitOpen = false;
  }

  isCircuitOpen() {
    // Cooldown: after 5 minutes of last failure, allow one trial
    if (this._circuitOpen && Date.now() - this._modelHealth.lastFailure > 5 * 60 * 1000) {
      return false; // half-open trial
    }
    return this._circuitOpen;
  }

  /* ─── Timeout budget ─── */

  maxCycleMs() {
    if (process.env.LOOP_MAX_CYCLE_MS) {
      const val = Number(process.env.LOOP_MAX_CYCLE_MS);
      if (!isNaN(val) && val > 0) return val;
    }
    const raw = process.env.LOOP_MAX_CYCLE_MINUTES;
    const val = raw ? Number(raw) : DEFAULT_MAX_CYCLE_MIN;
    if (isNaN(val) || val <= 0) return DEFAULT_MAX_CYCLE_MIN * 60 * 1000;
    return val * 60 * 1000;
  }

  /* ─── House-keeping ─── */

  healthCheck() {
    return {
      circuitOpen: this.isCircuitOpen(),
      dailyCost: this.getDailyCost(),
      overBudget: this.isOverBudget(),
      modelFailures: this._modelHealth.failures,
    };
  }
}

export default Safety;
