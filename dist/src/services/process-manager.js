import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { getAppBus } from '../core/app-bus.js';
import config from '../config/index.js';
const bus = getAppBus();
function logLevel(msg) {
    if (/^warn(ing)?\s/i.test(msg))
        return 'warn';
    if (/error|fail(ure)?|traceback|exception|errore/i.test(msg))
        return 'error';
    return 'info';
}
function pipeOutput(stream, prefix, msg) {
    stream.write(`[${prefix}] ${msg}`);
    bus.telemetry('log', prefix, msg.slice(0, 500), { level: logLevel(msg) });
}
export class ProcessManager {
    bridgePath;
    OC_PORT = 4096;
    DASHBOARD_PORT;
    HEALTH_PORT;
    litellmProc = null;
    opencodeProc = null;
    dashboardProc = null;
    healthOk = false;
    opencodeRestartDelay = 3000;
    litellmRestartDelay = 3000;
    startupTime = Date.now();
    isShuttingDown = false;
    manualStopOpencode = false;
    manualStopLiteLLM = false;
    constructor(bridgePath) {
        this.bridgePath = bridgePath;
        this.DASHBOARD_PORT = config.dashboard.port;
        this.HEALTH_PORT = config.health.port;
    }
    startLiteLLM() {
        this.manualStopLiteLLM = false;
        if (this.litellmProc)
            return;
        const configPath = join(this.bridgePath, 'config', 'litellm.yaml');
        if (!existsSync(configPath)) {
            console.warn('config/litellm.yaml not found, skipping LiteLLM');
            return;
        }
        const dockerComposePath = join(this.bridgePath, 'deploy', 'docker-compose.litellm.yml');
        if (existsSync(dockerComposePath)) {
            this.litellmProc = spawn('docker', ['compose', '-f', dockerComposePath, 'up', '--build'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    LITELLM_MASTER_KEY: config.litellm.masterKey,
                },
            });
        }
        else {
            let litellmBin;
            try {
                litellmBin = execSync('which litellm', { encoding: 'utf8' }).trim();
            }
            catch {
                litellmBin = join(homedir(), '.local', 'bin', 'litellm');
            }
            if (!litellmBin || !existsSync(litellmBin)) {
                console.warn('litellm not found, skipping');
                return;
            }
            this.litellmProc = spawn(litellmBin, ['--config', configPath, '--port', '4000', '--num_workers', '1'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    PYTHONPATH: this.bridgePath,
                    LITELLM_MASTER_KEY: config.litellm.masterKey,
                    OPENROUTER_API_KEY: config.litellm.providerKeys.openrouter,
                    NVIDIA_API_KEY: config.litellm.providerKeys.nvidia,
                    GROQ_API_KEY: config.litellm.providerKeys.groq,
                    MISTRAL_API_KEY: config.litellm.providerKeys.mistral,
                    CEREBRAS_API_KEY: config.litellm.providerKeys.cerebras,
                    XAI_API_KEY: config.litellm.providerKeys.xai,
                    GEMINI_API_KEY: config.litellm.providerKeys.gemini,
                    KILOCODE_API_KEY: config.litellm.providerKeys.kilocode,
                },
            });
        }
        this.litellmProc.on('error', (err) => console.error('[litellm] spawn error:', err.message));
        this.litellmProc.stdout?.on('data', (d) => pipeOutput(process.stdout, 'litellm', d.toString()));
        this.litellmProc.stderr?.on('data', (d) => pipeOutput(process.stderr, 'litellm-err', d.toString()));
        this.litellmProc.on('exit', async (code) => {
            bus.telemetry('process.status', 'bridge', `LiteLLM exited (code ${code})`, {
                level: 'warn',
                data: { name: 'litellm', status: 'stopped', code },
            });
            this.litellmProc = null;
            if (this.isShuttingDown || this.manualStopLiteLLM)
                return;
            this.litellmRestartDelay = Math.min(this.litellmRestartDelay * 2, 60000);
            await new Promise((resolve) => setTimeout(resolve, this.litellmRestartDelay));
            if (this.isShuttingDown || this.manualStopLiteLLM)
                return;
            this.startLiteLLM();
            const ok = await this.waitForLiteLLM(10);
            if (ok)
                this.litellmRestartDelay = 3000;
        });
    }
    stopLiteLLM() {
        this.manualStopLiteLLM = true;
        if (this.litellmProc) {
            try {
                this.litellmProc.kill('SIGTERM');
            }
            catch {
                // Best-effort
            }
            this.litellmProc = null;
        }
        const dockerComposePath = join(this.bridgePath, 'deploy', 'docker-compose.litellm.yml');
        if (existsSync(dockerComposePath)) {
            try {
                spawn('docker', ['compose', '-f', dockerComposePath, 'down']);
            }
            catch {
                console.error('[ProcessManager] Failed to run docker-compose down');
            }
        }
    }
    startDashboard() {
        if (this.dashboardProc)
            return;
        const entryPoint = join(this.bridgePath, 'src', 'dashboard', 'index.ts');
        if (!existsSync(entryPoint)) {
            console.warn('dashboard entry point not found, skipping');
            return;
        }
        this.dashboardProc = spawn(process.execPath, ['--import', 'tsx', entryPoint], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
        });
        this.dashboardProc.stdout?.on('data', (d) => pipeOutput(process.stdout, 'dashboard', d.toString()));
        this.dashboardProc.stderr?.on('data', (d) => pipeOutput(process.stderr, 'dashboard-err', d.toString()));
        this.dashboardProc.on('error', (err) => {
            console.error('[dashboard] spawn error:', err.message);
            bus.telemetry('log', 'dashboard', `spawn error: ${err.message}`, { level: 'error' });
        });
        this.dashboardProc.on('exit', (code) => {
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
            }
            catch {
                // Best-effort
            }
            this.dashboardProc = null;
        }
    }
    async waitForDashboard(retries = 15) {
        for (let i = 0; i < retries; i++) {
            try {
                const r = await fetch(`http://127.0.0.1:${this.DASHBOARD_PORT}/api/health`);
                if (r.ok)
                    return true;
            }
            catch {
                // Not ready yet
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return false;
    }
    async waitForLiteLLM(retries = 10) {
        for (let i = 0; i < retries; i++) {
            try {
                const r = await fetch('http://127.0.0.1:4000/health');
                if (r.ok)
                    return true;
            }
            catch {
                // Not ready yet
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return false;
    }
    stopOpencode() {
        this.manualStopOpencode = true;
        if (this.opencodeProc) {
            try {
                this.opencodeProc.kill('SIGTERM');
            }
            catch {
                // Best-effort
            }
            this.opencodeProc = null;
        }
        this.healthOk = false;
    }
    startOpencode() {
        this.manualStopOpencode = false;
        if (this.opencodeProc)
            return;
        const home = homedir();
        this.opencodeProc = spawn('opencode', ['serve', '--port', String(this.OC_PORT), '--print-logs', '--log-level', 'DEBUG'], {
            cwd: this.bridgePath,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PATH: `${process.env.PATH || ''}:${join(home, '.opencode', 'bin')}:${join(home, '.npm-global', 'bin')}`,
            },
        });
        this.opencodeProc.stdout?.on('data', (d) => pipeOutput(process.stdout, 'opencode', d.toString()));
        this.opencodeProc.stderr?.on('data', (d) => pipeOutput(process.stderr, 'opencode-err', d.toString()));
        this.opencodeProc.on('exit', async (code) => {
            bus.telemetry('process.status', 'bridge', `Opencode exited (code ${code})`, {
                level: 'warn',
                data: { name: 'opencode', status: 'stopped', code },
            });
            this.opencodeProc = null;
            this.healthOk = false;
            if (this.isShuttingDown || this.manualStopOpencode)
                return;
            this.opencodeRestartDelay = Math.min(this.opencodeRestartDelay * 2, 60000);
            await new Promise((resolve) => setTimeout(resolve, this.opencodeRestartDelay));
            if (this.isShuttingDown || this.manualStopOpencode)
                return;
            this.startOpencode();
            const ok = await this.waitForHealth(10);
            if (ok)
                this.opencodeRestartDelay = 3000;
        });
    }
    async waitForHealth(retries = 15) {
        for (let i = 0; i < retries; i++) {
            try {
                const r = await fetch(`http://127.0.0.1:${this.OC_PORT}/api/health`);
                if (r.ok) {
                    this.healthOk = true;
                    return true;
                }
            }
            catch {
                // Not ready yet
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return false;
    }
    startHealthServer(loopProcResolver) {
        const server = createServer((req, res) => {
            if (req.url === '/api/health' || req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    opencodeServer: this.healthOk,
                    opencodeRestartDelay: this.opencodeRestartDelay,
                    loopRunning: loopProcResolver(),
                    uptime: Math.floor((Date.now() - this.startupTime) / 1000),
                }));
            }
            else {
                res.writeHead(404);
                res.end('not found');
            }
        });
        server.listen(this.HEALTH_PORT, '127.0.0.1', () => {
            console.log(`Health server on http://127.0.0.1:${this.HEALTH_PORT}/health`);
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
            }
            catch {
                // Best-effort
            }
            this.opencodeProc = null;
        }
    }
}
