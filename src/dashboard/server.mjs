import http from 'node:http';
import express from 'express';
import * as os from 'node:os';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MetricsCollector } from './collector.mjs';
import { TelemetryStore } from './telemetry-store.mjs';
import { DashboardWebSocket } from './websocket.mjs';
import { createMetricsRouter } from './routes/metrics.mjs';
import { createSystemRouter } from './routes/system.mjs';
import { createProvidersRouter } from './routes/providers.mjs';
import { createLogsRouter } from './routes/logs.mjs';
import { createCommandsRouter } from './routes/commands.mjs';
import { createSettingsRouter } from './routes/settings.mjs';
import { createStaticRouter } from './routes/static.mjs';
import config from '../config/index.mjs';

const execFileAsync = promisify(execFile);

export class DashboardServer {
  constructor(port = 8081, systemController = null) {
    this.port = port;
    this.app = express();
    this.collector = new MetricsCollector();
    this.telemetryStore = new TelemetryStore(this.collector);
    this.systemController = systemController;

    this._setupMiddleware();
    this._setupRoutes();
    this._setupErrorHandler();
  }

  _setupMiddleware() {
    this.app.use(express.json());

    // CORS (Configurable, restricted)
    const origin = config.dashboard?.corsOrigin || `http://localhost:${this.port}`;
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // Auth (skip /api/internal from localhost)
    this.app.use('/api', (req, res, next) => {
      if (req.path.startsWith('/internal/')) {
        const ip = req.ip || req.connection.remoteAddress;
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
        return res.status(403).json({ error: 'Internal routes are localhost-only' });
      }

      const token = config.dashboard?.token;
      if (!token) return next();

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== token) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    });
  }

  _setupRoutes() {
    const deps = { collector: this.collector, telemetryStore: this.telemetryStore, config };
    this.app.use('/', createStaticRouter(deps));
    this.app.use('/api', createMetricsRouter(deps));
    this.app.use('/api', createSystemRouter(deps));
    this.app.use('/api', createProvidersRouter(deps));
    this.app.use('/api', createLogsRouter(deps));
    this.app.use(
      '/api',
      createCommandsRouter({ ...deps, systemController: this.systemController }),
    );
    this.app.use('/api', createSettingsRouter(deps));
  }

  _setupErrorHandler() {
    this.app.use((err, req, res, next) => {
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

    // Attach WebSocket
    this.wsServer = new DashboardWebSocket(
      this.server,
      this.telemetryStore,
      config.dashboard?.token,
    );
    this.telemetryStore.ws = this.wsServer;

    // Periodic tasks
    setInterval(() => this.collector.cleanupOld(), 3600_000);
    setInterval(() => this.collector.snapshotSessions(), 900_000);

    // Periodic sysinfo broadcast via telemetry (CPU/RAM every 3s, disk cached 60s)
    this._sysInfoInterval = setInterval(() => this._broadcastSysInfo(), 3000);
  }

  async _broadcastSysInfo() {
    try {
      // CPU via /proc/stat
      let cpu = 0;
      try {
        const stat1 = readFileSync('/proc/stat', 'utf-8');
        const cpu1 = stat1.split('\n').find((l) => l.startsWith('cpu '));
        const p1 = cpu1.trim().split(/\s+/).slice(1).map(Number);
        const tot1 = p1.reduce((a, b) => a + b, 0);
        const idle1 = p1[3];

        await new Promise((r) => setTimeout(r, 100));

        const stat2 = readFileSync('/proc/stat', 'utf-8');
        const cpu2 = stat2.split('\n').find((l) => l.startsWith('cpu '));
        const p2 = cpu2.trim().split(/\s+/).slice(1).map(Number);
        const tot2 = p2.reduce((a, b) => a + b, 0);
        const idle2 = p2[3];

        const td = tot2 - tot1,
          id = idle2 - idle1;
        cpu = td > 0 ? parseFloat((((td - id) / td) * 100).toFixed(1)) : 0;
      } catch (e) {
        // @expected-error: /proc/stat parsing can fail on some systems
      }

      // RAM
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const ramUsed = totalMem - freeMem;
      const ramPct = parseFloat(((ramUsed / totalMem) * 100).toFixed(1));

      // Disk via df (cached 60s, avoids slow df call every cycle)
      const now = Date.now();
      if (!this._lastDiskCheck || now - this._lastDiskCheck >= 60000) {
        try {
          const { stdout } = await execFileAsync('df', ['-BG', '/'], {
            encoding: 'utf-8',
            timeout: 2000,
          });
          const parts = stdout.trim().split('\n').pop().split(/\s+/);
          this._lastDiskTotal = parseInt(parts[1]);
          this._lastDiskUsed = parseInt(parts[2]);
          this._lastDiskPct = parseFloat(parts[4]);
          this._lastDiskCheck = now;
        } catch (e) {
          // @expected-error: df command might timeout or fail
        }
      }
      const diskUsed = this._lastDiskUsed || 0;
      const diskTotal = this._lastDiskTotal || 0;
      const diskPct = this._lastDiskPct || 0;

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
          diskUsed,
          diskTotal,
          diskPct,
          disk_pct: diskPct,
        },
      });
    } catch (e) {
      // @expected-error: system metrics collection can fail silently
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

  // Backward-compatible public API
  logCall(data) {
    this.collector.logCall(data);
  }
}
