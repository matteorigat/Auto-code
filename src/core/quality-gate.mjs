#!/usr/bin/env node
/**
 * Quality Gate — Plugin system for verification
 *
 * Ralph rule: no story is "done" until the gate passes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getAppBus } from './app-bus.mjs';

export class QualityGate {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.configPath = join(projectPath, '.hydra', 'gate.json');
    this.defaultChecks = [
      {
        name: 'typecheck',
        cmd: 'npx tsc --noEmit || npm run typecheck',
        timeout: 60,
        required: true,
      },
      { name: 'test', cmd: 'npm test', timeout: 120, required: true },
      { name: 'lint', cmd: 'npm run lint', timeout: 60, required: false },
    ];
  }

  async run({ appPort = null, cwd = null, taskId = null } = {}) {
    const checks = this.loadChecks(cwd);
    const results = [];
    let passed = true;
    const workDir = cwd || this.projectPath;

    const execTaskId = taskId || `qa-${Date.now()}`;
    let dockerAvailable = false;
    let dockerController;

    try {
      execFileSync('docker', ['ps'], { stdio: 'ignore' });
      dockerAvailable = true;
      const { getDockerController } = await import('../services/docker-sandbox.mjs');
      dockerController = getDockerController(this.projectPath);
    } catch (e) {
      console.warn('⚠️ Docker unavailable, fallback to direct local execution.');
    }

    if (dockerAvailable && dockerController) {
      try {
        await dockerController.startSandbox(execTaskId, workDir);
      } catch (e) {
        console.warn('⚠️ Failed to start Docker sandbox, fallback to direct local execution.');
        dockerAvailable = false;
      }
    }

    try {
      for (const c of checks) {
        let cmd = c.cmd;
        if (appPort) {
          cmd = cmd.replace(/\$\{APP_PORT\}/g, String(appPort));
        }

        let output = '';
        let exitCode = 0;

        if (dockerAvailable && dockerController) {
          try {
            const result = await dockerController.execute(
              execTaskId,
              cmd,
              (c.timeout || 60) * 1000,
            );
            exitCode = result.exitCode;
            output = (result.stdout || '') + '\n' + (result.stderr || '');
          } catch (e) {
            exitCode = 1;
            output = e.message || 'Failed to execute in sandbox';
          }
        } else {
          try {
            output = execFileSync('/bin/bash', ['-c', cmd], {
              cwd: workDir,
              timeout: (c.timeout || 60) * 1000,
              env: { ...process.env },
              encoding: 'utf-8',
            });
            exitCode = 0;
          } catch (e) {
            exitCode = e.status ?? 1;
            output = (e.stdout || '').toString() + '\n' + (e.stderr || '').toString();
          }
        }

        const ok = exitCode === 0;
        if (!ok && c.required) passed = false;

        results.push({
          name: c.name,
          passed: ok,
          required: c.required,
          output: output.slice(0, 2000),
          exitCode,
        });
      }
    } finally {
      if (dockerAvailable && dockerController) {
        try {
          dockerController.stopSandbox(execTaskId);
        } catch (e) {
          console.error(`[QualityGate] Failed to stop sandbox ${execTaskId}:`, e.message);
        }
      }
    }

    const bus = getAppBus();
    bus.telemetry('quality.gate_run', 'safety', `Quality Gate: ${passed ? 'PASSED' : 'FAILED'}`, {
      level: passed ? 'info' : 'warn',
      data: { passed, checks: results.length, taskId: taskId || null },
    });

    return { passed, results };
  }

  loadChecks(cwd = null) {
    const workDir = cwd || this.projectPath;
    if (existsSync(this.configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(this.configPath, 'utf-8'));
        if (cfg.checks && Array.isArray(cfg.checks)) return cfg.checks;
      } catch (e) {
        /* intentional: file missing or invalid JSON */
      }
    }

    const checks = [];

    // Auto-detect project type from config files
    const pkgPath = join(workDir, 'package.json');
    const pyReqPath = join(workDir, 'requirements.txt');
    const pyprojectPath = join(workDir, 'pyproject.toml');
    const goModPath = join(workDir, 'go.mod');
    const cargoPath = join(workDir, 'Cargo.toml');

    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const scripts = pkg.scripts || {};
        if (
          scripts.typecheck ||
          scripts['type-check'] ||
          existsSync(join(workDir, 'tsconfig.json'))
        ) {
          checks.push({
            name: 'typecheck',
            cmd: scripts.typecheck || 'npx tsc --noEmit',
            timeout: 60,
            required: true,
          });
        }
        if (scripts.test)
          checks.push({ name: 'test', cmd: 'npm test', timeout: 120, required: true });
        if (scripts.lint)
          checks.push({ name: 'lint', cmd: 'npm run lint', timeout: 60, required: false });
        if (scripts.build)
          checks.push({ name: 'build', cmd: 'npm run build', timeout: 120, required: true });
      } catch (e) {
        console.error('Ignored error:', e.message);
      }
    }

    if (existsSync(goModPath)) {
      checks.push({ name: 'test', cmd: 'go test ./...', timeout: 120, required: true });
      checks.push({ name: 'vet', cmd: 'go vet ./...', timeout: 60, required: true });
      checks.push({ name: 'build', cmd: 'go build ./...', timeout: 120, required: true });
    }

    if (existsSync(cargoPath)) {
      checks.push({ name: 'test', cmd: 'cargo test', timeout: 120, required: true });
      checks.push({
        name: 'clippy',
        cmd: 'cargo clippy -- -D warnings',
        timeout: 60,
        required: false,
      });
      checks.push({ name: 'build', cmd: 'cargo build', timeout: 120, required: true });
    }

    if (existsSync(pyprojectPath)) {
      checks.push({ name: 'test', cmd: 'pytest', timeout: 120, required: true });
      checks.push({ name: 'lint', cmd: 'ruff check .', timeout: 60, required: false });
    } else if (existsSync(pyReqPath)) {
      checks.push({ name: 'test', cmd: 'python -m pytest', timeout: 120, required: true });
      checks.push({ name: 'lint', cmd: 'python -m flake8 .', timeout: 60, required: false });
    }

    if (checks.length > 0) return checks;
    if (existsSync(pkgPath)) return [];
    return [];
  }
}

export default QualityGate;
