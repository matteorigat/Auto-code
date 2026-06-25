import { Router } from 'express';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createSystemRouter({ telemetryStore, config }) {
  const router = Router();

  // Disk cache (refreshed every 60s, avoids slow df call on every request)
  let diskCache = { used: 0, total: 0, pct: 0, lastCheck: 0 };

  async function getDiskUsage() {
    const now = Date.now();
    if (now - diskCache.lastCheck < 60000) return;
    try {
      const { stdout } = await execFileAsync('df', ['-BG', '/'], {
        encoding: 'utf-8',
        timeout: 2000,
      });
      const parts = stdout.trim().split('\n').pop().split(/\s+/);
      diskCache = {
        used: parseInt(parts[2]),
        total: parseInt(parts[1]),
        pct: parseFloat(parts[4]),
        lastCheck: now,
      };
    } catch (_) {}
  }

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      ts: new Date().toISOString(),
      wsClients: telemetryStore.ws ? telemetryStore.ws.getClientCount() : 0,
      eventsStored:
        telemetryStore.collector.get('SELECT COUNT(*) as count FROM events')?.count || 0,
    });
  });

  router.get('/sysinfo', async (req, res, next) => {
    try {
      // CPU via /proc/stat delta (reduced wait time)
      let cpu_pct = 0;
      try {
        const stat1 = readFileSync('/proc/stat', 'utf-8');
        const cpu1 = stat1.split('\n').find((l) => l.startsWith('cpu '));
        const p1 = cpu1.trim().split(/\s+/).slice(1).map(Number);
        const tot1 = p1.reduce((a, b) => a + b, 0);
        const idle1 = p1[3];

        await new Promise((r) => setTimeout(r, 100)); // 100ms is enough

        const stat2 = readFileSync('/proc/stat', 'utf-8');
        const cpu2 = stat2.split('\n').find((l) => l.startsWith('cpu '));
        const p2 = cpu2.trim().split(/\s+/).slice(1).map(Number);
        const tot2 = p2.reduce((a, b) => a + b, 0);
        const idle2 = p2[3];

        const td = tot2 - tot1,
          id = idle2 - idle1;
        cpu_pct = td > 0 ? parseFloat((((td - id) / td) * 100).toFixed(1)) : 0;
      } catch (_) {
        /* keep 0 */
      }

      await getDiskUsage();

      res.json({
        cpu_pct,
        cpuCores: os.cpus().length,
        uptime: os.uptime(),
        ram_used: os.totalmem() - os.freemem(),
        ram_total: os.totalmem(),
        ram_pct: parseFloat((((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1)),
        disk_used: diskCache.used,
        disk_total: diskCache.total,
        disk_pct: diskCache.pct,
        // camelCase aliases for frontend
        cpu: cpu_pct,
        ramUsed: os.totalmem() - os.freemem(),
        ramTotal: os.totalmem(),
        ramPct: parseFloat((((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1)),
        diskUsed: diskCache.used,
        diskTotal: diskCache.total,
        diskPct: diskCache.pct,
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/bridge-state', (req, res, next) => {
    try {
      const lv = telemetryStore.getSnapshot().liveState || {};
      res.json({
        running: lv.phase !== 'IDLE',
        phase: lv.phase || 'IDLE',
        project: lv.currentTask?.projectSlug || '—',
        taskTitle: lv.currentTask?.title || 'Waiting for active tasks in loop...',
        taskId: lv.currentTask?.id || null,
        tokens: lv.tokensToday || 0,
        cost: lv.costToday || 0,
        uptimeSec: lv.uptimeSec || 0,
        tasksCompleted: lv.tasksCompleted || 0,
        tasksBlocked: lv.tasksBlocked || 0,
        tasksTotal: lv.tasksTotal || 0,
        files: lv.files || [],
        lastError: lv.lastError || null,
        currentTask: lv.currentTask || null,
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
