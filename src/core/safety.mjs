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
    this._lastTokens = 0; // Track last tokens to calculate deltas
    
    // SOTA Phase 2: Force container execution
    this.forceContainerExecution = true; 
  }

  /* ─── Docker Sandbox Guard ─── */

  async runSafeCommand(taskId, command, workspacePath) {
    let dockerAvailable = false;
    try {
      execSync("docker ps", { stdio: "ignore" });
      dockerAvailable = true;
    } catch {}

    if (this.forceContainerExecution && dockerAvailable) {
      const { getDockerController } = await import("../../agents/docker-runtime.mjs");
      const controller = getDockerController(this.projectPath);
      try {
        await controller.startSandbox(taskId, workspacePath);
        return await controller.execute(taskId, command);
      } finally {
        try {
          controller.stopSandbox(taskId);
        } catch {}
      }
    } else {
      console.warn(`[Safety] WARNING: Running command on host. Docker available: ${dockerAvailable}.`);
      try {
        const out = execSync(command, { cwd: workspacePath || this.projectPath, shell: "/bin/bash", timeout: 300000 }).toString();
        return { exitCode: 0, stdout: out, stderr: "" };
      } catch (e) {
        return { exitCode: e.status || 1, stdout: e.stdout?.toString() || "", stderr: e.stderr?.toString() || e.message };
      }
    }
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
    const targetDir = cwd || this.projectPath;
    try {
      let currentBranch = execSync("git branch --show-current", { cwd: targetDir, encoding: "utf-8" }).trim() || "main";
      const safeId = storyId.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
      const branchName = `hydra/task-${safeId}`;

      if (currentBranch === branchName) {
        const mainBranch = this._mainBranch || "main";
        execSync(`git checkout ${mainBranch}`, { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });
        currentBranch = mainBranch;
      } else {
        this._mainBranch = currentBranch;
      }

      try {
        execSync("git add -A && git stash push -m 'hydra-temp-stash'", { cwd: targetDir, shell: "/bin/bash", timeout: 10000 });
      } catch {}

      try {
        execSync(`git branch -D ${branchName}`, { cwd: targetDir, shell: "/bin/bash", timeout: 10000 });
      } catch {}

      execSync(`git checkout -b ${branchName}`, { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });

      try {
        const stashes = execSync("git stash list", { cwd: targetDir, encoding: "utf-8" }).toString();
        if (stashes.includes("hydra-temp-stash")) {
          execSync("git stash pop", { cwd: targetDir, shell: "/bin/bash", timeout: 10000 });
        }
      } catch {}

      return true;
    } catch (err) {
      console.error(`[Safety] branch creation failed for ${storyId}:`, err.message);
      return false;
    }
  }

  rollbackLastSnapshot(storyId, cwd = null) {
    const targetDir = cwd || this.projectPath;
    try {
      const safeId = storyId.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
      const branchName = `hydra/task-${safeId}`;
      const mainBranch = this._mainBranch || "main";

      try {
        execSync("git reset --hard HEAD && git clean -fd", { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });
      } catch {}

      execSync(`git checkout ${mainBranch}`, { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });

      try {
        execSync(`git branch -D ${branchName}`, { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });
      } catch {}

      return true;
    } catch (e) {
      console.error(`[Safety] rollback failed for ${storyId}:`, e.message);
      return false;
    }
  }

  mergeTaskBranch(storyId, cwd = null) {
    const targetDir = cwd || this.projectPath;
    try {
      const safeId = storyId.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
      const branchName = `hydra/task-${safeId}`;
      const mainBranch = this._mainBranch || "main";

      execSync(`git checkout ${mainBranch}`, { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });

      // Merge the task branch
      execSync(`git merge ${branchName} --no-ff -m "Merge branch '${branchName}' into ${mainBranch}"`, { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });

      try {
        execSync(`git branch -d ${branchName}`, { cwd: targetDir, shell: "/bin/bash", timeout: 15000 });
      } catch {}

      return true;
    } catch (e) {
      console.error(`[Safety] merge failed for ${storyId}:`, e.message);
      return false;
    }
  }

  /* ─── Cost guard ─── */

  resetSessionCost() {
    this._lastCost = 0;
    this._lastTokens = 0;
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
  addCost(usd, tokens = 0) {
    this.resetCostWindow();
    const delta = Math.max(0, usd - this._lastCost);
    const tDelta = Math.max(0, tokens - this._lastTokens);
    this._lastCost = usd;
    this._lastTokens = tokens;
    if (delta > 0 || tDelta > 0) {
      this._costLog.push({ at: Date.now(), cost: delta, tokens: tDelta });
      this._saveCostLog();
    }
  }

  getDailyCost() {
    this.resetCostWindow();
    return this._costLog.reduce((sum, e) => sum + (e.cost || 0), 0);
  }

  getDailyTokens() {
    this.resetCostWindow();
    return this._costLog.reduce((sum, e) => sum + (e.tokens || 0), 0);
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
      dailyTokens: this.getDailyTokens(),
      overBudget: this.isOverBudget(),
      modelFailures: this._modelHealth.failures,
    };
  }
}

export default Safety;
