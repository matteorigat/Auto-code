#!/usr/bin/env node
/**
 * Safety — Circuit breaker, cost guard, git snapshot, guardrails
 *
 * Inspired by OpenHands Security Analyzer + Temporal idempotency.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config/index.mjs';
import { getAppBus } from './app-bus.mjs';

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

  /**
   * Run command safely within a Docker sandbox if available.
   * @param {string} taskId
   * @param {string} command
   * @param {string} workspacePath
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async runSafeCommand(taskId, command, workspacePath) {
    let dockerAvailable = false;
    try {
      execFileSync('docker', ['ps'], { stdio: 'ignore' });
      dockerAvailable = true;
    } catch (e) {
      console.error('Ignored error:', e.message);
    }

    if (this.forceContainerExecution && dockerAvailable) {
      const { getDockerController } = await import('../services/docker-sandbox.mjs');
      const controller = getDockerController(this.projectPath);
      try {
        await controller.startSandbox(taskId, workspacePath);
        return await controller.execute(taskId, command);
      } catch (err) {
        console.warn(
          `[Safety] Docker sandbox execution failed (${err.message}). Falling back to direct host execution.`,
        );
      } finally {
        try {
          controller.stopSandbox(taskId);
        } catch (e) {
          console.error('Ignored error:', e.message);
        }
      }
    }

    console.warn(
      `[Safety] WARNING: Running command on host. Docker available: ${dockerAvailable}.`,
    );
    try {
      const out = execFileSync('/bin/bash', ['-c', command], {
        cwd: workspacePath || this.projectPath,
        timeout: 300000,
        encoding: 'utf-8',
      });
      return { exitCode: 0, stdout: out, stderr: '' };
    } catch (e) {
      return {
        exitCode: e.status || 1,
        stdout: e.stdout?.toString() || '',
        stderr: e.stderr?.toString() || e.message,
      };
    }
  }

  _costLogPath() {
    return join(this.projectPath, '.hydra', 'cost-log.json');
  }

  _loadCostLog() {
    try {
      return JSON.parse(readFileSync(this._costLogPath(), 'utf-8'));
    } catch {
      return [];
    }
  }

  _saveCostLog() {
    try {
      writeFileSync(this._costLogPath(), JSON.stringify(this._costLog));
    } catch (e) {
      console.error('Failed to write file:', e.message);
    }
  }

  /* ─── Git snapshot (rollback target) ─── */

  snapshotBeforeWork(storyId, cwd = null) {
    const targetDir = cwd || this.projectPath;
    try {
      let currentBranch =
        execFileSync('git', ['branch', '--show-current'], {
          cwd: targetDir,
          encoding: 'utf-8',
        }).trim() || 'main';
      const safeId = storyId.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      const branchName = `hydra/task-${safeId}`;

      if (currentBranch === branchName) {
        const mainBranch = this._mainBranch || this._detectMainBranch(targetDir);
        execFileSync('git', ['checkout', mainBranch], { cwd: targetDir, timeout: 15000 });
        currentBranch = mainBranch;
      } else {
        this._mainBranch = currentBranch;
      }

      try {
        execFileSync('git', ['add', '-A'], { cwd: targetDir, timeout: 10000 });
        execFileSync('git', ['stash', 'push', '-m', 'hydra-temp-stash'], {
          cwd: targetDir,
          timeout: 10000,
        });
      } catch (e) {
        console.error('Ignored error:', e.message);
      }

      try {
        execFileSync('git', ['branch', '-D', branchName], { cwd: targetDir, timeout: 10000 });
      } catch (e) {
        console.error('Ignored error:', e.message);
      }

      execFileSync('git', ['checkout', '-b', branchName], { cwd: targetDir, timeout: 15000 });

      try {
        const stashes = execFileSync('git', ['stash', 'list'], {
          cwd: targetDir,
          encoding: 'utf-8',
        }).toString();
        if (stashes.includes('hydra-temp-stash')) {
          execFileSync('git', ['stash', 'pop'], { cwd: targetDir, timeout: 10000 });
        }
      } catch (e) {
        console.error('Ignored error:', e.message);
      }

      return true;
    } catch (err) {
      console.error(`[Safety] branch creation failed for ${storyId}:`, err.message);
      return false;
    }
  }

  rollbackLastSnapshot(storyId, cwd = null) {
    const targetDir = cwd || this.projectPath;
    try {
      const safeId = storyId.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      const branchName = `hydra/task-${safeId}`;
      const mainBranch = this._mainBranch || this._detectMainBranch(targetDir);

      try {
        execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: targetDir, timeout: 15000 });
        execFileSync('git', ['clean', '-fd'], { cwd: targetDir, timeout: 15000 });
      } catch (e) {
        console.error('Ignored error:', e.message);
      }

      execFileSync('git', ['checkout', mainBranch], { cwd: targetDir, timeout: 15000 });

      try {
        execFileSync('git', ['branch', '-D', branchName], { cwd: targetDir, timeout: 15000 });
      } catch (e) {
        console.error('Ignored error:', e.message);
      }

      return true;
    } catch (e) {
      console.error(`[Safety] rollback failed for ${storyId}:`, e.message);
      return false;
    }
  }

  _detectMainBranch(cwd) {
    try {
      const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      return ref.replace('refs/remotes/origin/', '');
    } catch (e) {
      console.error('Ignored error:', e.message);
    }
    try {
      const current = execFileSync('git', ['branch', '--show-current'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (current && !current.startsWith('hydra/')) return current;
    } catch (e) {
      console.error('Ignored error:', e.message);
    }
    try {
      const branches = execFileSync('git', ['branch'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (branches.includes('master')) return 'master';
      if (branches.includes('main')) return 'main';
    } catch (e) {
      console.error('Ignored error:', e.message);
    }
    return 'master';
  }

  mergeTaskBranch(storyId, cwd = null) {
    const targetDir = cwd || this.projectPath;
    try {
      const safeId = storyId.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      const branchName = `hydra/task-${safeId}`;
      const mainBranch = this._mainBranch || this._detectMainBranch(targetDir);

      execFileSync('git', ['checkout', mainBranch], { cwd: targetDir, timeout: 15000 });

      // Merge the task branch
      execFileSync(
        'git',
        ['merge', branchName, '--no-ff', '-m', `Merge branch '${branchName}' into ${mainBranch}`],
        { cwd: targetDir, timeout: 15000 },
      );

      try {
        execFileSync('git', ['branch', '-d', branchName], { cwd: targetDir, timeout: 15000 });
      } catch (e) {
        console.error('Ignored error:', e.message);
      }

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
   * Add cost to accumulator and check budget limits.
   * @param {number} usd The total cost from runtime
   * @param {number} tokens The total tokens from runtime
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

      const totalToday = this.getDailyCost();
      const limit = config.loop.dailyCostLimit || DEFAULT_MAX_COST;
      getAppBus().telemetry('cost.update', 'safety', `Daily cost: $${totalToday.toFixed(4)}`, {
        data: { totalToday, limit, pct: (totalToday / limit) * 100 },
      });
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

  /**
   * Check if the daily budget has been exceeded.
   * @returns {boolean}
   */
  isOverBudget() {
    const max = config.loop.dailyCostLimit;
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
    return config.loop.maxCycleMs;
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
