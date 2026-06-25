import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { getAppBus } from '../core/app-bus.mjs';
import config from '../config/index.mjs';

const bus = getAppBus();

function logLevel(msg) {
  if (/^warn(ing)?\s/i.test(msg)) return 'warn';
  if (/error|fail(ure)?|traceback|exception|errore/i.test(msg)) return 'error';
  if (/warn(ing)?/i.test(msg)) return 'warn';
  return 'info';
}

export class ProcessManager {
  constructor(bridgePath) {
    this.bridgePath = bridgePath;
    this.litellmProc = null;
    this.opencodeProc = null;
    this.dashboardProc = null;
    this.healthOk = false;
    this.opencodeRestartDelay = 3000;
    this.litellmRestartDelay = 3000;
    this._startupTime = Date.now();
    this.OC_PORT = 4096;
    this.DASHBOARD_PORT = config.dashboard.port;
    this.HEALTH_PORT = config.health.port;
    this.isShuttingDown = false;
    this.manualStopOpencode = false;
    this.manualStopLiteLLM = false;
  }

  startLiteLLM() {
    this.manualStopLiteLLM = false;
    if (this.litellmProc) return;
    const configPath = join(this.bridgePath, 'config', 'litellm.yaml');
    if (!existsSync(configPath)) {
      console.warn('⚠️ config/litellm.yaml non trovato, salto LiteLLM');
      return;
    }

    const dockerComposePath = join(this.bridgePath, 'deploy', 'docker-compose.litellm.yml');
    if (existsSync(dockerComposePath)) {
      console.log('🚀 Starting LiteLLM proxy via docker-compose...');
      this.litellmProc = spawn('docker', ['compose', '-f', dockerComposePath, 'up', '--build'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } else {
      const LITELLM_BIN = join(homedir(), '.local', 'bin', 'litellm');
      if (!existsSync(LITELLM_BIN)) {
        console.warn('⚠️ litellm non trovato in ~/.local/bin, salto');
        return;
      }
      console.log('🚀 Starting LiteLLM proxy on :4000...');
      this.litellmProc = spawn(
        LITELLM_BIN,
        ['--config', configPath, '--port', '4000', '--num_workers', '1'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONPATH: this.bridgePath,
            OPENROUTER_API_KEY: config.litellm.providerKeys.openrouter,
            NVIDIA_API_KEY: config.litellm.providerKeys.nvidia,
            GROQ_API_KEY: config.litellm.providerKeys.groq,
            MISTRAL_API_KEY: config.litellm.providerKeys.mistral,
            CEREBRAS_API_KEY: config.litellm.providerKeys.cerebras,
            XAI_API_KEY: config.litellm.providerKeys.xai,
            GEMINI_API_KEY: config.litellm.providerKeys.gemini,
            KILOCODE_API_KEY: config.litellm.providerKeys.kilocode,
          },
        },
      );
    }

    this.litellmProc.on('error', (err) => console.error('[litellm] spawn error:', err.message));
    this.litellmProc.stdout.on('data', (d) => {
      process.stdout.write(`[litellm] ${d}`);
      const msg = d.toString().trim();
      bus.telemetry('system.litellm.out', 'bridge', msg.slice(0, 500), { level: logLevel(msg) });
    });
    this.litellmProc.stderr.on('data', (d) => {
      process.stderr.write(`[litellm-err] ${d}`);
      const msg = d.toString().trim();
      bus.telemetry('system.litellm.out', 'bridge', msg.slice(0, 500), { level: logLevel(msg) });
    });
    this.litellmProc.on('exit', async (code) => {
      console.log(`⚠️ LiteLLM terminato (codice ${code})`);
      bus.telemetry('system.litellm.status', 'bridge', `LiteLLM exited (code ${code})`, {
        level: 'warn',
        data: { name: 'litellm', status: 'stopped', code },
      });
      this.litellmProc = null;

      if (this.isShuttingDown || this.manualStopLiteLLM) {
        console.log(`⚠️ LiteLLM terminato (codice ${code}) [shutdown/manual stop].`);
        return;
      }

      console.log(
        `⚠️ LiteLLM terminated (code ${code}), restarting in ${this.litellmRestartDelay}ms...`,
      );
      await new Promise((r) => setTimeout(r, this.litellmRestartDelay));
      if (this.isShuttingDown || this.manualStopLiteLLM) return;
      this.litellmRestartDelay = Math.min(this.litellmRestartDelay * 2, 60000); // max 60s
      this.startLiteLLM();
      const ok = await this.waitForLiteLLM(10);
      if (ok) this.litellmRestartDelay = 3000; // reset on success
    });
  }

  stopLiteLLM() {
    this.manualStopLiteLLM = true;
    if (this.litellmProc) {
      try {
        this.litellmProc.kill('SIGTERM');
      } catch (e) {
        console.error('Ignored error:', e.message);
      }
      this.litellmProc = null;
    }
    const dockerComposePath = join(this.bridgePath, 'deploy', 'docker-compose.litellm.yml');
    if (existsSync(dockerComposePath)) {
      console.log('🛑 Arresto LiteLLM proxy via docker-compose...');
      try {
        spawn('docker', ['compose', '-f', dockerComposePath, 'down']);
      } catch (e) {
        console.error('[ProcessManager] Failed to run docker-compose down:', e.message);
      }
    }
  }

  startDashboard() {
    if (this.dashboardProc) return;
    const entryPoint = join(this.bridgePath, 'src', 'dashboard', 'index.mjs');
    if (!existsSync(entryPoint)) {
      console.warn('dashboard entry point non trovato, salvo');
      return;
    }
    console.log('Starting dashboard server on :' + this.DASHBOARD_PORT + '...');
    this.dashboardProc = spawn('node', [entryPoint], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.dashboardProc.stdout.on('data', (d) => {
      process.stdout.write(`[dashboard] ${d}`);
      const msg = d.toString().trim();
      telemetry[logLevel(msg)]('dashboard', msg);
    });
    this.dashboardProc.stderr.on('data', (d) => {
      process.stderr.write(`[dashboard-err] ${d}`);
      const msg = d.toString().trim();
      telemetry[logLevel(msg)]('dashboard', msg);
    });
    this.dashboardProc.on('error', (err) => {
      console.error('[dashboard] spawn error:', err.message);
      telemetry.error('dashboard', `spawn error: ${err.message}`);
    });
    this.dashboardProc.on('exit', (code) => {
      console.log(`dashboard terminato (codice ${code})`);
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

  stopDashboard() {
    if (this.dashboardProc) {
      try {
        this.dashboardProc.kill('SIGTERM');
      } catch (e) {
        console.error('Ignored error:', e.message);
      }
      this.dashboardProc = null;
    }
  }

  async waitForDashboard(retries = 15) {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.DASHBOARD_PORT}/api/health`);
        if (r.ok) {
          console.log('dashboard pronto');
          return true;
        }
      } catch (_) {
        /* not ready yet */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.warn('dashboard unavailable after', retries, 'attempts');
    return false;
  }

  async waitForLiteLLM(retries = 10) {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch('http://127.0.0.1:4000/health');
        if (r.ok) {
          console.log('✅ LiteLLM pronto');
          return true;
        }
      } catch (e) {
        console.error('Ignored error:', e.message);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.warn('⚠️ LiteLLM unavailable after', retries, 'attempts');
    return false;
  }

  stopOpencode() {
    this.manualStopOpencode = true;
    if (this.opencodeProc) {
      try {
        this.opencodeProc.kill('SIGTERM');
      } catch (e) {
        console.error('Ignored error:', e.message);
      }
      this.opencodeProc = null;
    }
    this.healthOk = false;
  }

  startOpencode() {
    this.manualStopOpencode = false;
    if (this.opencodeProc) return;
    console.log(`🚀 Starting opencode server... (backoff: ${this.opencodeRestartDelay}ms)`);
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
    this.opencodeProc.stdout.on('data', (d) => {
      process.stdout.write(`[opencode] ${d}`);
      const msg = d.toString().trim();
      bus.telemetry('system.opencode.out', 'bridge', msg.slice(0, 500), { level: logLevel(msg) });
    });
    this.opencodeProc.stderr.on('data', (d) => {
      process.stderr.write(`[opencode-err] ${d}`);
      const msg = d.toString().trim();
      bus.telemetry('system.opencode.err', 'bridge', msg.slice(0, 500), { level: logLevel(msg) });
    });
    this.opencodeProc.on('exit', async (code) => {
      bus.telemetry('process.status', 'bridge', `Opencode exited (code ${code})`, {
        level: 'warn',
        data: { name: 'opencode', status: 'stopped', code },
      });
      this.opencodeProc = null;
      this.healthOk = false;

      if (this.isShuttingDown || this.manualStopOpencode) {
        console.log(`⚠️ opencode terminato (codice ${code}) [shutdown/manual stop].`);
        return;
      }
      console.log(
        `⚠️ opencode terminated (code ${code}), restarting in ${this.opencodeRestartDelay}ms...`,
      );
      await new Promise((r) => setTimeout(r, this.opencodeRestartDelay));
      if (this.isShuttingDown || this.manualStopOpencode) return;
      this.opencodeRestartDelay = Math.min(this.opencodeRestartDelay * 2, 60000); // max 60s
      this.startOpencode();
      const ok = await this.waitForHealth(10);
      if (ok) this.opencodeRestartDelay = 3000; // reset on success
    });
  }

  async waitForHealth(retries = 15) {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.OC_PORT}/api/health`);
        if (r.ok) {
          this.healthOk = true;
          console.log('✅ opencode server pronto');
          return true;
        }
      } catch (_) {
        console.error('Ignored error:', _.message);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.error('❌ opencode server unavailable after', retries, 'tentativi');
    return false;
  }

  startHealthServer(loopProcResolver) {
    const server = createServer((req, res) => {
      if (req.url === '/api/health' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            opencodeServer: this.healthOk,
            opencodeRestartDelay: this.opencodeRestartDelay,
            loopRunning: loopProcResolver ? !!loopProcResolver() : false,
            uptime: Math.floor((Date.now() - this._startupTime) / 1000),
          }),
        );
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(this.HEALTH_PORT, '127.0.0.1', () => {
      console.log(`💚 Health server on http://127.0.0.1:${this.HEALTH_PORT}/health`);
    });
    server.on('error', (err) => console.error('Health server error:', err.message));
    return server;
  }

  stopAll() {
    this.isShuttingDown = true;
    this.stopDashboard();
    this.stopLiteLLM();
    if (this.opencodeProc) {
      try {
        this.opencodeProc.kill('SIGTERM');
      } catch (e) {
        console.error('Ignored error:', e.message);
      }
      this.opencodeProc = null;
    }
  }
}
