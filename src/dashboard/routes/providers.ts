import { Router, Request, Response } from 'express';
import { createQuotaRouter } from './providers/quota.js';
import { createDiscoveryRouter } from './providers/discovery.js';
import { createHealthRouter } from './providers/health.js';
import { createAliasesRouter } from './providers/aliases.js';
import { auditProviders } from '../providers.js';
import type { MetricsCollector } from '../collector.js';
import type { TelemetryStore } from '../telemetry-store.js';
import type { AppConfig } from '../../config/index.js';

interface RouterDeps {
  config: AppConfig;
  collector: MetricsCollector;
  telemetryStore: TelemetryStore;
}

export function createProvidersRouter({ config, collector, telemetryStore }: RouterDeps) {
  const router = Router();

  router.get('/providers/audit', async (req: Request, res: Response) => {
    const probe = req.query.probe === '1';
    res.json(await auditProviders(probe));
  });

  router.use(createQuotaRouter({ collector, telemetryStore, config }));
  router.use(createDiscoveryRouter({ collector }));
  router.use(createHealthRouter({ collector, telemetryStore }));
  router.use(createAliasesRouter());

  return router;
}
