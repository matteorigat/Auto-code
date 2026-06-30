import { Router, Request, Response, NextFunction } from 'express';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TelemetryStore } from '../telemetry-store.js';
import type { AppConfig } from '../../config/index.js';
import { getProjectList } from '../../core/projects.js';

const execFileAsync = promisify(execFile);

interface SystemDeps {
  telemetryStore: TelemetryStore;
  config: AppConfig;
}

export function createSystemRouter({ telemetryStore, config }: SystemDeps) {
  const router = Router();

  let diskCache = { used: 0, total: 0, pct: 0, lastCheck: 0 };

  async function getDiskUsage(): Promise<void> {
    const now = Date.now();
    if (now - diskCache.lastCheck < 60000) return;
    try {
      const isMac = process.platform === 'darwin';
      const args = isMac ? ['-g', '/'] : ['-BG', '/'];
      const { stdout } = await execFileAsync('df', args, {
        encoding: 'utf-8',
        timeout: 2000,
      });
      const parts = stdout.trim().split('\n').pop()?.split(/\s+/);
      if (parts && parts.length >= 5) {
        diskCache = {
          used: parseInt(parts[2]),
          total: parseInt(parts[1]),
          pct: parseFloat(parts[4] as string),
          lastCheck: now,
        };
      }
    } catch {
      // ignore df errors
    }
  }

  router.get('/projects', (req: Request, res: Response) => {
    res.json(getProjectList());
  });

  router.get('/health', async (req: Request, res: Response) => {
    const ws = telemetryStore.ws;
    const count = ws ? ws.getClientCount() : 0;
    const row = telemetryStore.collector.get('SELECT COUNT(*) as count FROM events');

    let mrHealth: Record<string, unknown> | null = null;
    try {
      const r = await fetch('http://127.0.0.1:20128/api/health', {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) mrHealth = (await r.json()) as Record<string, unknown>;
    } catch {
      // ModelRouter might not be running
    }

    res.json({
      status: 'ok',
      ts: new Date().toISOString(),
      wsClients: count,
      eventsStored: (row?.count as number) || 0,
      modelRouter: mrHealth,
    });
  });

  function cpuTimes(): { total: number; idle: number } {
    const cpus = os.cpus();
    let total = 0;
    let idle = 0;
    for (const cpu of cpus) {
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      idle += cpu.times.idle;
    }
    return { total, idle };
  }

  router.get('/sysinfo', async (req: Request, res: Response, next: NextFunction) => {
    try {
      let cpu_pct = 0;
      try {
        const { total: tot1, idle: idle1 } = cpuTimes();

        await new Promise((r) => setTimeout(r, 100));

        const { total: tot2, idle: idle2 } = cpuTimes();

        const td = tot2 - tot1;
        const id = idle2 - idle1;
        cpu_pct = td > 0 ? parseFloat((((td - id) / td) * 100).toFixed(1)) : 0;
      } catch {
        // ignore CPU measurement errors
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

  router.get('/bridge-state', (req: Request, res: Response, next: NextFunction) => {
    try {
      const lv = telemetryStore.getSnapshot().liveState;
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
