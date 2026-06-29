import { Router } from 'express';
import { createHealthRouter } from './providers/health.js';
const OR_API_KEY = () => process.env.OMNIROUTE_API_KEY || process.env.API_KEY_SECRET || '';
async function fetchOrHealthMatrix() {
    const apiKey = OR_API_KEY();
    if (!apiKey)
        return null;
    try {
        const res = await fetch('http://127.0.0.1:20128/api/providers/health-matrix', {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
export function createProvidersRouter({ collector, telemetryStore }) {
    const router = Router();
    router.get('/providers-matrix', async (req, res, next) => {
        try {
            const matrix = await fetchOrHealthMatrix();
            if (!matrix) {
                res.json({ error: 'OmniRoute health-matrix unavailable' });
                return;
            }
            res.json(matrix);
        }
        catch (e) {
            next(e);
        }
    });
    router.use(createHealthRouter({ collector, telemetryStore }));
    return router;
}
