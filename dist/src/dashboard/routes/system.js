import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getProjectList } from '../../core/projects.js';
const execFileAsync = promisify(execFile);
export function createSystemRouter({ telemetryStore, config }) {
    const router = Router();
    let diskCache = { used: 0, total: 0, pct: 0, lastCheck: 0 };
    async function getDiskUsage() {
        const now = Date.now();
        if (now - diskCache.lastCheck < 60000)
            return;
        try {
            const { stdout } = await execFileAsync('df', ['-BG', '/'], {
                encoding: 'utf-8',
                timeout: 2000,
            });
            const parts = stdout.trim().split('\n').pop()?.split(/\s+/);
            if (parts) {
                diskCache = {
                    used: parseInt(parts[2]),
                    total: parseInt(parts[1]),
                    pct: parseFloat(parts[4]),
                    lastCheck: now,
                };
            }
        }
        catch {
            // ignore df errors
        }
    }
    router.get('/projects', (req, res) => {
        res.json(getProjectList());
    });
    router.get('/health', async (req, res) => {
        const ws = telemetryStore.ws;
        const count = ws ? ws.getClientCount() : 0;
        const row = telemetryStore.collector.get('SELECT COUNT(*) as count FROM events');
        let orHealth = null;
        const apiKey = process.env.OMNIROUTE_API_KEY || process.env.API_KEY_SECRET || '';
        if (apiKey) {
            try {
                const r = await fetch('http://127.0.0.1:20128/api/monitoring/health', {
                    signal: AbortSignal.timeout(3000),
                });
                if (r.ok)
                    orHealth = (await r.json());
            }
            catch {
                // OmniRoute might not be running
            }
        }
        res.json({
            status: 'ok',
            ts: new Date().toISOString(),
            wsClients: count,
            eventsStored: row?.count || 0,
            omniroute: orHealth ? { status: orHealth.status, version: orHealth.system?.version, uptime: orHealth.system?.uptime } : null,
        });
    });
    router.get('/sysinfo', async (req, res, next) => {
        try {
            let cpu_pct = 0;
            try {
                const stat1 = await readFile('/proc/stat', 'utf-8');
                const cpu1 = stat1.split('\n').find((l) => l.startsWith('cpu '));
                if (cpu1) {
                    const p1 = cpu1.trim().split(/\s+/).slice(1).map(Number);
                    const tot1 = p1.reduce((a, b) => a + b, 0);
                    const idle1 = p1[3];
                    await new Promise((r) => setTimeout(r, 100));
                    const stat2 = await readFile('/proc/stat', 'utf-8');
                    const cpu2 = stat2.split('\n').find((l) => l.startsWith('cpu '));
                    if (cpu2) {
                        const p2 = cpu2.trim().split(/\s+/).slice(1).map(Number);
                        const tot2 = p2.reduce((a, b) => a + b, 0);
                        const idle2 = p2[3];
                        const td = tot2 - tot1, id = idle2 - idle1;
                        cpu_pct = td > 0 ? parseFloat((((td - id) / td) * 100).toFixed(1)) : 0;
                    }
                }
            }
            catch {
                // ignore /proc/stat read errors
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
        }
        catch (e) {
            next(e);
        }
    });
    router.get('/bridge-state', (req, res, next) => {
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
        }
        catch (e) {
            next(e);
        }
    });
    return router;
}
