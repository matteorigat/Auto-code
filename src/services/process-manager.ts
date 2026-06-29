import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { getAppBus } from '../core/app-bus.js';
import config from '../config/index.js';

const bus = getAppBus();

function logLevel(msg: string): string {
  if (/^warn(ing)?\s/i.test(msg)) return 'warn';
  if (/error|fail(ure)?|traceback|exception|errore/i.test(msg)) return 'error';
  return 'info';
}

function pipeOutput(stream: NodeJS.WriteStream, prefix: string, msg: string): void {
  stream.write(`[${prefix}] ${msg}`);
  bus.telemetry('log', prefix, msg.slice(0, 500), { level: logLevel(msg) });
}

export class ProcessManager {
  readonly bridgePath: string;
  readonly OC_PORT: number = 4096;
  readonly DASHBOARD_PORT: number;
  readonly HEALTH_PORT: number;

  omnirouteProc: ChildProcess | null = null;
  opencodeProc: ChildProcess | null = null;
  dashboardProc: ChildProcess | null = null;
  healthOk: boolean = false;
  opencodeRestartDelay: number = 3000;
  omnirouteRestartDelay: number = 3000;
  readonly startupTime: number = Date.now();
  isShuttingDown: boolean = false;
  manualStopOpencode: boolean = false;
  manualStopOmniRoute: boolean = false;

  constructor(bridgePath: string) {
    this.bridgePath = bridgePath;
    this.DASHBOARD_PORT = config.dashboard.port;
    this.HEALTH_PORT = config.health.port;
  }

  startOmniRoute(): void {
    this.manualStopOmniRoute = false;
    if (this.omnirouteProc) return;
    const port = config.omniroute.port;

    const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
    const node22Dir = join(nvmDir, 'v22.22.3');
    const node22Bin = join(node22Dir, 'bin', 'node');
    const omnirouteEntry = join(node22Dir, 'lib', 'node_modules', 'omniroute', 'bin', 'omniroute.mjs');

    if (!existsSync(omnirouteEntry)) {
      console.warn(
        'omniroute not found in nvm node22 global modules, skipping. Install with: nvm use 22 && npm install -g omniroute',
      );
      return;
    }

    const cleanEnv: Record<string, string> = {
      PATH: `${join(node22Dir, 'bin')}:${process.env.PATH || ''}`,
      NVM_BIN: join(node22Dir, 'bin'),
      NVM_DIR: join(homedir(), '.nvm'),
      HOME: homedir(),
      USER: process.env.USER || '',
      PORT: String(config.omniroute.port),
      JWT_SECRET: process.env.JWT_SECRET || '***REMOVED***',
      OMNIROUTE_API_KEY:
        process.env.API_KEY_SECRET || process.env.OMNIROUTE_API_KEY || '***REMOVED***',
      API_KEY_SECRET:
        process.env.API_KEY_SECRET || process.env.OMNIROUTE_API_KEY || '***REMOVED***',
      INITIAL_PASSWORD: process.env.INITIAL_PASSWORD || '***REMOVED***',
      DATA_DIR: process.env.OMNIROUTE_DATA_DIR || join(homedir(), '.omniroute'),
    };

    this.omnirouteProc = spawn(node22Bin, [omnirouteEntry], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
    });

    this.omnirouteProc.on('error', (err: Error) =>
      console.error('[omniroute] spawn error:', err.message),
    );
    this.omnirouteProc.stdout?.on('data', (d: Buffer) =>
      pipeOutput(process.stdout, 'omniroute', d.toString()),
    );
    this.omnirouteProc.stderr?.on('data', (d: Buffer) =>
      pipeOutput(process.stderr, 'omniroute-err', d.toString()),
    );
    this.omnirouteProc.on('exit', async (code: number | null) => {
      bus.telemetry('process.status', 'bridge', `OmniRoute exited (code ${code})`, {
        level: 'warn',
        data: { name: 'omniroute', status: 'stopped', code },
      });
      this.omnirouteProc = null;

      if (this.isShuttingDown || this.manualStopOmniRoute) return;

      this.omnirouteRestartDelay = Math.min(this.omnirouteRestartDelay * 2, 60000);
      await new Promise((resolve) => setTimeout(resolve, this.omnirouteRestartDelay));
      if (this.isShuttingDown || this.manualStopOmniRoute) return;
      this.startOmniRoute();
      const ok = await this.waitForOmniRoute(15);
      if (ok) this.omnirouteRestartDelay = 3000;
    });
  }

  stopOmniRoute(): void {
    this.manualStopOmniRoute = true;
    if (this.omnirouteProc) {
      try {
        this.omnirouteProc.kill('SIGTERM');
      } catch {
        // Best-effort
      }
      this.omnirouteProc = null;
    }
  }

  startDashboard(): void {
    if (this.dashboardProc) return;
    const entryPoint = join(this.bridgePath, 'src', 'dashboard', 'index.ts');
    if (!existsSync(entryPoint)) {
      console.warn('dashboard entry point not found, skipping');
      return;
    }
    this.dashboardProc = spawn(process.execPath, ['--import', 'tsx', entryPoint], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.dashboardProc.stdout?.on('data', (d: Buffer) =>
      pipeOutput(process.stdout, 'dashboard', d.toString()),
    );
    this.dashboardProc.stderr?.on('data', (d: Buffer) =>
      pipeOutput(process.stderr, 'dashboard-err', d.toString()),
    );
    this.dashboardProc.on('error', (err: Error) => {
      console.error('[dashboard] spawn error:', err.message);
      bus.telemetry('log', 'dashboard', `spawn error: ${err.message}`, { level: 'error' });
    });
    this.dashboardProc.on('exit', (code: number | null) => {
      bus.telemetry('process.status', 'bridge', `Dashboard exited (code ${code})`, {
        level: 'warn',
        data: { name: 'dashboard', status: 'stopped', code },
      });
      this.dashboardProc = null;
      if (!this.isShuttingDown) {
        setTimeout(() => this.startDashboard(), 2000);
      }
    });
  }

  stopDashboard(): void {
    if (this.dashboardProc) {
      try {
        this.dashboardProc.kill('SIGTERM');
      } catch {
        // Best-effort
      }
      this.dashboardProc = null;
    }
  }

  async waitForDashboard(retries: number = 15): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.DASHBOARD_PORT}/api/health`);
        if (r.ok) return true;
      } catch {
        // Not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  async waitForOmniRoute(retries: number = 15): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch(
          `http://127.0.0.1:${config.omniroute.port}/v1/models`,
          { headers: { Authorization: `Bearer ${config.omniroute.apiKey}` } },
        );
        if (r.ok) return true;
      } catch {
        // Not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  stopOpencode(): void {
    this.manualStopOpencode = true;
    if (this.opencodeProc) {
      try {
        this.opencodeProc.kill('SIGTERM');
      } catch {
        // Best-effort
      }
      this.opencodeProc = null;
    }
    this.healthOk = false;
  }

  startOpencode(): void {
    this.manualStopOpencode = false;
    if (this.opencodeProc) return;
    const home = homedir();
    this.opencodeProc = spawn(
      'opencode',
      ['serve', '--port', String(this.OC_PORT), '--print-logs', '--log-level', 'DEBUG'],
      {
        cwd: this.bridgePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${process.env.PATH || ''}:${join(home, '.opencode', 'bin')}:${join(home, '.npm-global', 'bin')}`,
        },
      },
    );
    this.opencodeProc.stdout?.on('data', (d: Buffer) =>
      pipeOutput(process.stdout, 'opencode', d.toString()),
    );
    this.opencodeProc.stderr?.on('data', (d: Buffer) =>
      pipeOutput(process.stderr, 'opencode-err', d.toString()),
    );
    this.opencodeProc.on('exit', async (code: number | null) => {
      bus.telemetry('process.status', 'bridge', `Opencode exited (code ${code})`, {
        level: 'warn',
        data: { name: 'opencode', status: 'stopped', code },
      });
      this.opencodeProc = null;
      this.healthOk = false;

      if (this.isShuttingDown || this.manualStopOpencode) return;

      this.opencodeRestartDelay = Math.min(this.opencodeRestartDelay * 2, 60000);
      await new Promise((resolve) => setTimeout(resolve, this.opencodeRestartDelay));
      if (this.isShuttingDown || this.manualStopOpencode) return;
      this.startOpencode();
      const ok = await this.waitForHealth(10);
      if (ok) this.opencodeRestartDelay = 3000;
    });
  }

  async waitForHealth(retries: number = 15): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.OC_PORT}/api/health`);
        if (r.ok) {
          this.healthOk = true;
          return true;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  startHealthServer(loopProcResolver: () => boolean): Server {
    const server = createServer((req, res) => {
      if (req.url === '/api/health' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            opencodeServer: this.healthOk,
            opencodeRestartDelay: this.opencodeRestartDelay,
            loopRunning: loopProcResolver(),
            uptime: Math.floor((Date.now() - this.startupTime) / 1000),
          }),
        );
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(this.HEALTH_PORT, '127.0.0.1', () => {
      console.log(`Health server on http://127.0.0.1:${this.HEALTH_PORT}/health`);
    });
    server.on('error', (err: Error) => console.error('Health server error:', err.message));
    return server;
  }

  stopAll(): void {
    this.isShuttingDown = true;
    this.stopDashboard();
    this.stopOmniRoute();
    if (this.opencodeProc) {
      try {
        this.opencodeProc.kill('SIGTERM');
      } catch {
        // Best-effort
      }
      this.opencodeProc = null;
    }
  }
}
