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
    // disk cache
    _lastDiskCheck;
    _lastDiskTotal;
    _lastDiskUsed;
    _lastDiskPct;
    // macOS memory cache
    _lastMemCheck;
    _lastRamUsed;
    _lastRamPct;
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
    _getMemoryUsage() {
        const total = os.totalmem();
        // On macOS, os.freemem() only returns "free" pages, ignoring inactive/cached.
        // Use vm_stat for a reading closer to Activity Monitor.
        if (process.platform === 'darwin') {
            const now = Date.now();
            if (this._lastMemCheck && now - this._lastMemCheck < 30000 && this._lastRamUsed !== undefined) {
                return { used: this._lastRamUsed, total, pct: this._lastRamPct };
            }
            // Fall back to simple arithmetic if vm_stat cache expired
        }
        const free = os.freemem();
        const used = total - free;
        const pct = parseFloat(((used / total) * 100).toFixed(1));
        return { used, total, pct };
    }
    async _refreshMemoryUsage() {
        if (process.platform !== 'darwin')
            return;
        try {
            const { stdout } = await execFileAsync('vm_stat', [], {
                encoding: 'utf-8',
                timeout: 2000,
            });
            let pageSize = 16384;
            const pages = {};
            for (const line of stdout.trim().split('\n')) {
                if (line.startsWith('Mach Virtual Memory Statistics:'))
                    continue;
                if (line.startsWith('page size of')) {
                    const m = line.match(/(\d+)/);
                    if (m)
                        pageSize = parseInt(m[1]);
                    continue;
                }
                const colonIdx = line.indexOf(':');
                if (colonIdx === -1)
                    continue;
                const key = line.substring(0, colonIdx).trim();
                const val = parseInt(line.substring(colonIdx + 1).replace(/[.\s]/g, ''));
                if (!isNaN(val))
                    pages[key] = val;
            }
            const active = pages['Pages active'] || 0;
            const wired = pages['Pages wired down'] || 0;
            const compressed = pages['Pages occupied by compressor'] || 0;
            const usedBytes = (active + wired + compressed) * pageSize;
            this._lastRamUsed = usedBytes;
            this._lastRamPct = parseFloat(((usedBytes / os.totalmem()) * 100).toFixed(1));
            this._lastMemCheck = Date.now();
        }
        catch {
            // vm_stat failed, will fall back to os.freemem()
        }
    }
    async _getDiskUsage() {
        try {
            const { stdout } = await execFileAsync('df', ['-k', '/'], {
                encoding: 'utf-8',
                timeout: 2000,
            });
            const lines = stdout.trim().split('\n');
            const parts = lines[lines.length - 1]?.split(/\s+/);
            if (parts && parts.length >= 5) {
                const usedKB = parseInt(parts[2]);
                const availKB = parseInt(parts[3]);
                const totalKB = usedKB + availKB;
                const total = Math.round((totalKB / (1024 * 1024)) * 10) / 10;
                const used = Math.round((usedKB / (1024 * 1024)) * 10) / 10;
                const pct = totalKB > 0 ? parseFloat(((usedKB / totalKB) * 100).toFixed(1)) : 0;
                return { total, used, pct };
            }
        }
        catch {
            // df command might timeout or fail
        }
        return null;
    }
    async _broadcastSysInfo() {
        try {
            // CPU
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
            // RAM — refresh vm_stat on macOS every 30s
            const now = Date.now();
            if (process.platform === 'darwin' && (!this._lastMemCheck || now - this._lastMemCheck >= 30000)) {
                await this._refreshMemoryUsage();
            }
            const { used: ramUsed, total: ramTotal, pct: ramPct } = this._getMemoryUsage();
            // DISK — refresh every 60s, compute pct from used/(used+available)
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
                    ramTotal,
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
