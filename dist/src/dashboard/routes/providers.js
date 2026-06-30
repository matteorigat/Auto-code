import { Router } from 'express';
import { createHealthRouter } from './providers/health.js';
async function proxyModelRouter(path) {
    try {
        const base = process.env.MODELROUTER_URL || 'http://127.0.0.1:20128';
        const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
        if (r.ok)
            return (await r.json());
    }
    catch { /* ModelRouter unavailable */ }
    return null;
}
export function createProvidersRouter({ config, collector, telemetryStore }) {
    const router = Router();
    router.get('/providers-matrix', async (req, res) => {
        const data = await proxyModelRouter('/api/providers/health-matrix');
        res.json(data ?? { providers: {} });
    });
    router.get('/model-router/accounts', async (req, res) => {
        const data = await proxyModelRouter('/api/model-router/accounts');
        res.json(data ?? { total: 0, accounts: [] });
    });
    router.get('/model-router/stats', async (req, res) => {
        const data = await proxyModelRouter('/api/model-router/stats');
        res.json(data ?? { totalRequests: 0, totalFailures: 0, perModel: {} });
    });
    router.get('/model-router/logs', async (req, res) => {
        const data = await proxyModelRouter('/api/model-router/logs');
        res.json(data ?? { logs: [] });
    });
    router.get('/model-router/models', async (req, res) => {
        const data = await proxyModelRouter('/api/model-router/models');
        res.json(data ?? { tiers: {}, aliases: {}, stats: {} });
    });
    router.post('/model-router/reset-slot', async (req, res) => {
        try {
            const base = process.env.MODELROUTER_URL || 'http://127.0.0.1:20128';
            const r = await fetch(`${base}/api/model-router/reset-slot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
                signal: AbortSignal.timeout(5000),
            });
            res.status(r.status).json(await r.json());
        }
        catch {
            res.status(502).json({ error: 'ModelRouter unavailable' });
        }
    });
    router.use(createHealthRouter({ collector, telemetryStore }));
    return router;
}
