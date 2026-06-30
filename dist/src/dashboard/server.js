import express from 'express';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MetricsCollector } from './collector.js';
import { TelemetryStore } from './telemetry-store.js';
import { DashboardWebSocket } from './websocket.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createSystemRouter } from './routes/system.js';
import { createProvidersRouter } from './routes/providers.js';
import { createLogsRouter } from './routes/logs.js';
import { createCommandsRouter } from './routes/commands.js';
import { createSettingsRouter } from './routes/settings.js';
import { createStaticRouter } from './routes/static.js';
import config from '../config/index.js';
const execFileAsync = promisify(execFile);
export class DashboardServer {
    port;
    app;
    collector;
    telemetryStore;
    systemController;
    server;
    wsServer;
    _sysInfoInterval;
    _lastDiskCheck;
    _lastDiskTotal;
    _lastDiskUsed;
    _lastDiskPct;
    constructor(port = 8081, systemController = null) {
        this.port = port;
        this.app = express();
        this.collector = new MetricsCollector();
        this.telemetryStore = new TelemetryStore(this.collector);
        this.systemController = systemController ?? {};
        this._setupMiddleware();
        this._setupRoutes();
        this._setupErrorHandler();
    }
    _setupMiddleware() {
        this.app.use(express.json());
        const origin = config.dashboard?.corsOrigin || `http://localhost:${this.port}`;
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', origin);
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            if (req.method === 'OPTIONS')
                return res.sendStatus(204);
            next();
        });
        this.app.use('/api', (req, res, next) => {
            if (req.path.startsWith('/internal/')) {
                const ip = req.ip || req.socket.remoteAddress;
                if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')
                    return next();
                return res.status(403).json({ error: 'Internal routes are localhost-only' });
            }
            const token = config.dashboard?.token;
            if (!token)
                return next();
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== token) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            next();
        });
    }
    _setupRoutes() {
        const deps = { collector: this.collector, telemetryStore: this.telemetryStore, config };
        this.app.use('/', createStaticRouter());
        this.app.use('/api', createMetricsRouter(deps));
        this.app.use('/api', createSystemRouter(deps));
        this.app.use('/api', createProvidersRouter(deps));
        this.app.use('/api', createLogsRouter(deps));
        this.app.use('/api', createCommandsRouter({ ...deps, systemController: this.systemController }));
        this.app.use('/api', createSettingsRouter(deps));
    }
    _setupErrorHandler() {
        this.app.use((err, req, res, _next) => {
            res.status(err.status || 500).json({
                success: false,
                error: err.message || 'Internal Server Error',
            });
        });
    }
    start() {
        this.server = this.app.listen(this.port, config.dashboard?.bindAddress || '0.0.0.0', () => {
            this.telemetryStore.ingest({
                type: 'log',
                source: 'dashboard',
                level: 'info',
                message: `Dashboard running on http://${config.dashboard?.bindAddress || '0.0.0.0'}:${this.port}`,
            });
        });
        this.wsServer = new DashboardWebSocket(this.server, this.telemetryStore, config.dashboard?.token);
        this.telemetryStore.ws = this.wsServer;
        setInterval(() => this.collector.cleanupOld(), 3600_000);
        setInterval(() => this.collector.snapshotSessions(), 900_000);
        this._sysInfoInterval = setInterval(() => this._broadcastSysInfo(), 3000);
    }
    _cpuTimes() {
        const cpus = os.cpus();
        let total = 0;
        let idle = 0;
        for (const cpu of cpus) {
            total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
            idle += cpu.times.idle;
        }
        return { total, idle };
    }
    async _getDiskUsage() {
        try {
            const isMac = process.platform === 'darwin';
            const args = isMac ? ['-g', '/'] : ['-BG', '/'];
            const { stdout } = await execFileAsync('df', args, {
                encoding: 'utf-8',
                timeout: 2000,
            });
            const lines = stdout.trim().split('\n');
            const parts = lines[lines.length - 1]?.split(/\s+/);
            if (parts && parts.length >= 5) {
                return {
                    total: parseInt(parts[1]),
                    used: parseInt(parts[2]),
                    pct: parseFloat(parts[4]),
                };
            }
        }
        catch {
            // df command might timeout or fail
        }
        return null;
    }
    async _broadcastSysInfo() {
        try {
            let cpu = 0;
            try {
                const { total: tot1, idle: idle1 } = this._cpuTimes();
                await new Promise((r) => setTimeout(r, 100));
                const { total: tot2, idle: idle2 } = this._cpuTimes();
                const td = tot2 - tot1;
                const id = idle2 - idle1;
                cpu = td > 0 ? parseFloat((((td - id) / td) * 100).toFixed(1)) : 0;
            }
            catch {
                // CPU measurement can fail on some systems
            }
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const ramUsed = totalMem - freeMem;
            const ramPct = parseFloat(((ramUsed / totalMem) * 100).toFixed(1));
            const now = Date.now();
            if (!this._lastDiskCheck || now - this._lastDiskCheck >= 60000) {
                const disk = await this._getDiskUsage();
                if (disk) {
                    this._lastDiskTotal = disk.total;
                    this._lastDiskUsed = disk.used;
                    this._lastDiskPct = disk.pct;
                    this._lastDiskCheck = now;
                }
            }
            this.telemetryStore.ingest({
                type: 'system.metrics',
                level: 'debug',
                source: 'bridge',
                message: 'System metrics snapshot',
                data: {
                    cpu,
                    cpu_pct: cpu,
                    cpuCores: os.cpus().length,
                    uptime: os.uptime(),
                    ramUsed,
                    ramTotal: totalMem,
                    ramPct,
                    ram_pct: ramPct,
                    diskUsed: this._lastDiskUsed || 0,
                    diskTotal: this._lastDiskTotal || 0,
                    diskPct: this._lastDiskPct || 0,
                    disk_pct: this._lastDiskPct || 0,
                },
            });
        }
        catch {
            // system metrics collection can fail silently
        }
    }
    stop() {
        if (this.server) {
            this.server.close();
        }
        if (this._sysInfoInterval) {
            clearInterval(this._sysInfoInterval);
        }
    }
    logCall(data) {
        this.collector.logCall(data);
    }
}
