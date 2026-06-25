import { Router } from 'express';
import { createQuotaRouter } from './providers/quota.mjs';
import { createDiscoveryRouter } from './providers/discovery.mjs';
import { createHealthRouter } from './providers/health.mjs';
import { createAliasesRouter } from './providers/aliases.mjs';

// Stub for now, can move audit implementation to its own file later if needed
import { auditProviders } from '../providers.mjs';

export function createProvidersRouter({ config, collector, telemetryStore }) {
  const router = Router();

  router.get('/providers/audit', async (req, res) => {
    const probe = req.query.probe === '1';
    res.json(await auditProviders(probe));
  });

  // Mount sub-routers
  router.use(createQuotaRouter({ collector, telemetryStore }));
  router.use(createDiscoveryRouter({ collector }));
  router.use(createHealthRouter({ collector, telemetryStore }));
  router.use(createAliasesRouter());

  return router;
}
