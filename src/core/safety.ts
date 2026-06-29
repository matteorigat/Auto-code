import { execFileSync, type ExecSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config/index.js';
import { getAppBus } from './app-bus.js';

const COST_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_COST = 10;

export interface CostEntry {
  at: number;
  cost: number;
  tokens: number;
}

interface ModelHealth {
  failures: number;
  lastFailure: number;
}

interface ExecError extends Error {
  status?: number;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DockerController {
  startSandbox(taskId: string, workspacePath: string): Promise<string>;
  execute(taskId: string, command: string): Promise<CommandResult>;
  stopSandbox(taskId: string): void;
}

export class Safety {
  readonly projectPath: string;
  readonly forceContainerExecution: boolean = true;

  private costLog: CostEntry[] = [];
  private modelHealth: ModelHealth = { failures: 0, lastFailure: 0 };
  private circuitOpen: boolean = false;
  private lastCost: number = 0;
  private lastTokens: number = 0;
  private mainBranch: string | undefined;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.costLog = this.loadCostLog();
  }

  async runSafeCommand(
    taskId: string,
    command: string,
    workspacePath: string,
  ): Promise<CommandResult> {
    let dockerAvailable = false;
    try {
      execFileSync('docker', ['ps'], { stdio: 'ignore' });
      dockerAvailable = true;
    } catch {
      // Docker not available
    }

    if (this.forceContainerExecution && dockerAvailable) {
      try {
        const { getDockerController } = await import('../services/docker-sandbox.js');
        const controller: DockerController = getDockerController(this.projectPath);
        try {
          await controller.startSandbox(taskId, workspacePath);
          return await controller.execute(taskId, command);
        } catch (err: unknown) {
          console.warn(
            `[Safety] Docker sandbox execution failed (${(err as Error).message}). Falling back to direct host execution.`,
          );
        } finally {
          try {
            controller.stopSandbox(taskId);
          } catch {
            // Best-effort cleanup
          }
        }
      } catch (err: unknown) {
        console.warn(`[Safety] Failed to import docker controller: ${(err as Error).message}`);
      }
    }

    console.warn(`[Safety] Running command on host. Docker available: ${dockerAvailable}.`);
    return this.runOnHost(command, workspacePath);
  }

  private runOnHost(command: string, workspacePath: string): CommandResult {
    try {
      const out = execFileSync('/bin/bash', ['-c', command], {
        cwd: workspacePath || this.projectPath,
        timeout: 300000,
        encoding: 'utf-8',
      } as ExecSyncOptions);
      return { exitCode: 0, stdout: out as string, stderr: '' };
    } catch (err: unknown) {
      const execErr = err as ExecError;
      return {
        exitCode: execErr.status || 1,
        stdout:
          typeof execErr.stdout === 'string' ? execErr.stdout : (execErr.stdout?.toString() ?? ''),
        stderr:
          typeof execErr.stderr === 'string'
            ? execErr.stderr
            : (execErr.stderr?.toString() ?? execErr.message),
      };
    }
  }

  private costLogPath(): string {
    return join(this.projectPath, '.hydra', 'cost-log.json');
  }

  private loadCostLog(): CostEntry[] {
    try {
      return JSON.parse(readFileSync(this.costLogPath(), 'utf-8')) as CostEntry[];
    } catch {
      return [];
    }
  }

  private saveCostLog(): void {
    try {
      writeFileSync(this.costLogPath(), JSON.stringify(this.costLog));
    } catch {
      console.error('[Safety] Failed to write cost log');
    }
  }

  snapshotBeforeWork(storyId: string, cwd: string | null = null): boolean {
    const targetDir = cwd || this.projectPath;
    try {
      const currentBranch =
        execFileSync('git', ['branch', '--show-current'], {
          cwd: targetDir,
          encoding: 'utf-8',
        })
          .toString()
          .trim() || 'main';
      const safeId = storyId.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      const branchName = `hydra/task-${safeId}`;

      let effectiveMain = this.mainBranch;
      if (currentBranch === branchName) {
        effectiveMain = this.mainBranch || this.detectMainBranch(targetDir);
        execFileSync('git', ['checkout', effectiveMain], { cwd: targetDir, timeout: 15000 });
      } else {
        this.mainBranch = currentBranch;
        effectiveMain = currentBranch;
      }

      try {
        execFileSync('git', ['add', '-A'], { cwd: targetDir, timeout: 10000 });
        execFileSync('git', ['stash', 'push', '-m', 'hydra-temp-stash'], {
          cwd: targetDir,
          timeout: 10000,
        });
      } catch {
        // No changes to stash
      }

      try {
        execFileSync('git', ['branch', '-D', branchName], { cwd: targetDir, timeout: 10000 });
      } catch {
        // Branch may not exist
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
      } catch {
        // No stash to pop
      }

      return true;
    } catch (err: unknown) {
      console.error(`[Safety] branch creation failed for ${storyId}: ${(err as Error).message}`);
      return false;
    }
  }

  rollbackLastSnapshot(storyId: string, cwd: string | null = null): boolean {
    const targetDir = cwd || this.projectPath;
    try {
      const safeId = storyId.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      const branchName = `hydra/task-${safeId}`;
      const mainBranch = this.mainBranch || this.detectMainBranch(targetDir);

      try {
        execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: targetDir, timeout: 15000 });
        execFileSync('git', ['clean', '-fd'], { cwd: targetDir, timeout: 15000 });
      } catch {
        // Best-effort cleanup
      }

      execFileSync('git', ['checkout', mainBranch], { cwd: targetDir, timeout: 15000 });

      try {
        execFileSync('git', ['branch', '-D', branchName], { cwd: targetDir, timeout: 15000 });
      } catch {
        // Branch may not exist
      }

      return true;
    } catch (err: unknown) {
      console.error(`[Safety] rollback failed for ${storyId}: ${(err as Error).message}`);
      return false;
    }
  }

  private detectMainBranch(cwd: string): string {
    try {
      const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      })
        .toString()
        .trim();
      return ref.replace('refs/remotes/origin/', '');
    } catch {
      // Fall through
    }
    try {
      const current = execFileSync('git', ['branch', '--show-current'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      })
        .toString()
        .trim();
      if (current && !current.startsWith('hydra/')) return current;
    } catch {
      // Fall through
    }
    try {
      const branches = execFileSync('git', ['branch'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      })
        .toString()
        .trim();
      if (branches.includes('master')) return 'master';
      if (branches.includes('main')) return 'main';
    } catch {
      // Fall through
    }
    return 'master';
  }

  mergeTaskBranch(storyId: string, cwd: string | null = null): boolean {
    const targetDir = cwd || this.projectPath;
    try {
      const safeId = storyId.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      const branchName = `hydra/task-${safeId}`;
      const mainBranch = this.mainBranch || this.detectMainBranch(targetDir);

      execFileSync('git', ['checkout', mainBranch], { cwd: targetDir, timeout: 15000 });

      execFileSync(
        'git',
        ['merge', branchName, '--no-ff', '-m', `Merge branch '${branchName}' into ${mainBranch}`],
        { cwd: targetDir, timeout: 15000 },
      );

      try {
        execFileSync('git', ['branch', '-d', branchName], { cwd: targetDir, timeout: 15000 });
      } catch {
        // Best-effort cleanup
      }

      return true;
    } catch (err: unknown) {
      console.error(`[Safety] merge failed for ${storyId}: ${(err as Error).message}`);
      return false;
    }
  }

  resetSessionCost(): void {
    this.lastCost = 0;
    this.lastTokens = 0;
  }

  private resetCostWindow(): void {
    const cutoff = Date.now() - COST_WINDOW_MS;
    this.costLog = this.costLog.filter((e) => e.at > cutoff);
  }

  addCost(usd: number, tokens: number = 0): void {
    this.resetCostWindow();
    const delta = Math.max(0, usd - this.lastCost);
    const tDelta = Math.max(0, tokens - this.lastTokens);
    this.lastCost = usd;
    this.lastTokens = tokens;
    if (delta > 0 || tDelta > 0) {
      this.costLog.push({ at: Date.now(), cost: delta, tokens: tDelta });
      this.saveCostLog();

      const totalToday = this.getDailyCost();
      const limit = config.loop.dailyCostLimit || DEFAULT_MAX_COST;
      getAppBus().telemetry('cost.update', 'safety', `Daily cost: $${totalToday.toFixed(4)}`, {
        data: { totalToday, limit, pct: (totalToday / limit) * 100 },
      });
    }
  }

  getDailyCost(): number {
    this.resetCostWindow();
    return this.costLog.reduce((sum, e) => sum + (e.cost || 0), 0);
  }

  getDailyTokens(): number {
    this.resetCostWindow();
    return this.costLog.reduce((sum, e) => sum + (e.tokens || 0), 0);
  }

  isOverBudget(): boolean {
    const max = config.loop.dailyCostLimit;
    if (isNaN(max) || max <= 0) return this.getDailyCost() >= DEFAULT_MAX_COST;
    return this.getDailyCost() >= max;
  }

  recordApiFailure(statusCode: number): void {
    if (statusCode >= 500 || statusCode === 429) {
      this.modelHealth.failures++;
      this.modelHealth.lastFailure = Date.now();
    }
    if (this.modelHealth.failures >= 3) {
      this.circuitOpen = true;
    }
  }

  recordApiSuccess(): void {
    this.modelHealth.failures = Math.max(0, this.modelHealth.failures - 1);
    if (this.modelHealth.failures === 0) this.circuitOpen = false;
  }

  isCircuitOpen(): boolean {
    if (this.circuitOpen && Date.now() - this.modelHealth.lastFailure > 5 * 60 * 1000) {
      return false;
    }
    return this.circuitOpen;
  }

  maxCycleMs(): number {
    return config.loop.maxCycleMs;
  }

  healthCheck(): Record<string, number | boolean> {
    return {
      circuitOpen: this.isCircuitOpen(),
      dailyCost: this.getDailyCost(),
      dailyTokens: this.getDailyTokens(),
      overBudget: this.isOverBudget(),
      modelFailures: this.modelHealth.failures,
    };
  }
}

export default Safety;
