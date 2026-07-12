import { Router, Request, Response, NextFunction } from 'express';
import { createHealthRouter } from './providers/health.js';
import type { MetricsCollector } from '../collector.js';
import type { TelemetryStore } from '../telemetry-store.js';
import type { AppConfig } from '../../config/index.js';

interface RouterDeps {
  config: AppConfig;
  collector: MetricsCollector;
  telemetryStore: TelemetryStore;
}

async function proxyModelRouter(path: string): Promise<Record<string, any> | null> {
  try {
    const base = process.env.MODELROUTER_URL || 'http://127.0.0.1:20128';
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) return (await r.json()) as Record<string, any>;
  } catch {
    /* ModelRouter unavailable */
  }
  return null;
}

export function createProvidersRouter({ config, collector, telemetryStore }: RouterDeps) {
  const router = Router();

  router.get('/providers-matrix', async (req: Request, res: Response) => {
    const data = await proxyModelRouter('/api/providers/health-matrix');
    res.json(data ?? { providers: {} });
  });

  router.get('/model-router/accounts', async (req: Request, res: Response) => {
    const data = await proxyModelRouter('/api/model-router/accounts');
    res.json(data ?? { total: 0, accounts: [] });
  });

  router.get('/model-router/stats', async (req: Request, res: Response) => {
    const data = await proxyModelRouter('/api/model-router/stats');
    res.json(data ?? { totalRequests: 0, totalFailures: 0, perModel: {} });
  });

  router.get('/model-router/logs', async (req: Request, res: Response) => {
    const data = await proxyModelRouter('/api/model-router/logs');
    res.json(data ?? { logs: [] });
  });

  router.get('/model-router/models', async (req: Request, res: Response) => {
    const data = await proxyModelRouter('/api/model-router/models');
    res.json(data ?? { tiers: {}, aliases: {}, stats: {} });
  });

  router.post('/model-router/reset-slot', async (req: Request, res: Response) => {
    try {
      const base = process.env.MODELROUTER_URL || 'http://127.0.0.1:20128';
      const r = await fetch(`${base}/api/model-router/reset-slot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(5000),
      });
      res.status(r.status).json(await r.json());
    } catch {
      res.status(502).json({ error: 'ModelRouter unavailable' });
    }
  });

  router.get('/model-router/proxy-status', async (req: Request, res: Response) => {
    const data = await proxyModelRouter('/api/model-router/proxy-status');
    res.json(data ?? { strategy: 'unknown', proxies: [] });
  });

  router.post('/model-router/proxy-rotate', async (req: Request, res: Response) => {
    try {
      const base = process.env.MODELROUTER_URL || 'http://127.0.0.1:20128';
      const r = await fetch(`${base}/api/model-router/proxy-rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      res.status(r.status).json(await r.json());
    } catch {
      res.status(502).json({ error: 'ModelRouter unavailable' });
    }
  });

  router.use(createHealthRouter({ collector, telemetryStore }));

  return router;
}
