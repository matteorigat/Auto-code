import { Router } from 'express';
import { createQuotaRouter } from './providers/quota.js';
import { createDiscoveryRouter } from './providers/discovery.js';
import { createHealthRouter } from './providers/health.js';
import { createAliasesRouter } from './providers/aliases.js';
import { auditProviders } from '../providers.js';
export function createProvidersRouter({ config, collector, telemetryStore }) {
    const router = Router();
    router.get('/providers/audit', async (req, res) => {
        const probe = req.query.probe === '1';
        res.json(await auditProviders(probe));
    });
    router.use(createQuotaRouter({ collector, telemetryStore, config }));
    router.use(createDiscoveryRouter({ collector }));
    router.use(createHealthRouter({ collector, telemetryStore }));
    router.use(createAliasesRouter());
    return router;
}
