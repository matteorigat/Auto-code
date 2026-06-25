import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { getQuotaManager } from '../../../core/quota-manager.mjs';
import { resolveUpstreamProvider } from './utils.mjs';

export function createQuotaRouter({ collector, telemetryStore, config }) {
  const router = Router();
  const CONFIG_DIR = join(process.cwd(), 'config');
  const HYDRA_DIR = join(process.cwd(), '.hydra');

  router.get('/quota', (req, res) => {
    const quota = getQuotaManager().getStatus();

    const rangeFrom = req.query.from || null;
    const rangeTo = req.query.to || null;

    if (collector) {
      try {
        const PROVIDER_DB_MAP = {
          opencode_zen: 'openai',
        };

        if (rangeFrom) {
          const fromStr = rangeFrom.replace('T', ' ').substring(0, 19);
          const toStr = rangeTo
            ? rangeTo.replace('T', ' ').substring(0, 19)
            : collector.get("SELECT datetime('now') as dt").dt;

          for (const [key, q] of Object.entries(quota)) {
            const dbProviders = PROVIDER_DB_MAP[key] || key;
            const dbList = dbProviders.split(',');

            const rpdRow = collector.get(
              `SELECT COUNT(*) as cnt FROM model_calls WHERE ts >= ? AND ts <= ? AND provider IN (${dbList.map(() => '?').join(',')})`,
              [fromStr, toStr, ...dbList],
            );
            const dbRpd = rpdRow?.cnt || 0;
            const dbRph = dbRpd;

            if (q.type === 'per-model') {
              const modelCount = Object.keys(q.models || {}).length || 1;
              const perModel = Math.ceil(dbRpd / modelCount);
              for (const mk of Object.keys(q.models || {})) {
                const m = q.models[mk];
                m.rpdUsed = perModel;
                m.rphUsed = Math.ceil(dbRph / modelCount);
              }
            } else if (q.models) {
              for (const mk of Object.keys(q.models)) {
                const m = q.models[mk];
                m.rpdUsed = dbRpd;
                m.rphUsed = dbRph;
              }
            } else {
              q.rpdUsed = dbRpd;
              q.rphUsed = dbRph;
            }
          }
        } else {
          const yesterday = collector.get("SELECT datetime('now', '-1 day') as dt").dt;

          const rows = collector.query(
            `SELECT provider, COUNT(*) as cnt FROM model_calls WHERE ts >= ? GROUP BY provider`,
            [yesterday],
          );
          const dbCounts = {};
          for (const r of rows) dbCounts[r.provider] = r.cnt;

          const rphRows = {};
          for (const [key, q] of Object.entries(quota)) {
            const dbProviders = PROVIDER_DB_MAP[key] || key;
            const period = q.rphPeriod || 1;
            const since = collector.get(`SELECT datetime('now', ? || ' hours') as dt`, [
              `-${period}`,
            ]).dt;
            const prph = collector.query(
              `SELECT COUNT(*) as cnt FROM model_calls WHERE ts >= ? AND provider IN (${dbProviders
                .split(',')
                .map(() => '?')
                .join(',')})`,
              [since, ...dbProviders.split(',')],
            );
            rphRows[key] = prph[0]?.cnt || 0;
          }

          for (const [key, q] of Object.entries(quota)) {
            const dbProviders = PROVIDER_DB_MAP[key] || key;
            const dbKeys = dbProviders.split(',');
            let dbRpd = 0;
            for (const dk of dbKeys) {
              if (dbCounts[dk] != null) dbRpd = Math.max(dbRpd, dbCounts[dk]);
            }

            if (q.type === 'per-model') {
              const modelCount = Object.keys(q.models || {}).length || 1;
              const perModel = Math.ceil(dbRpd / modelCount);
              for (const mk of Object.keys(q.models || {})) {
                const m = q.models[mk];
                m.rpdUsed = Math.max(m.rpdUsed || 0, perModel);
                m.rphUsed = Math.max(m.rphUsed || 0, Math.ceil((rphRows[key] || 0) / modelCount));
              }
            } else if (q.models) {
              for (const mk of Object.keys(q.models)) {
                const m = q.models[mk];
                m.rpdUsed = Math.max(m.rpdUsed || 0, dbRpd);
                m.rphUsed = Math.max(m.rphUsed || 0, rphRows[key] || 0);
              }
            } else {
              q.rpdUsed = Math.max(q.rpdUsed || 0, dbRpd);
              q.rphUsed = Math.max(q.rphUsed || 0, rphRows[key] || 0);
            }
          }
        }
      } catch (e) {
        console.warn('[quota] DB merge failed:', e.message);
      }
    }

    res.json(quota);
  });

  router.get('/routing-chain', (req, res, next) => {
    try {
      const configPath = join(CONFIG_DIR, 'litellm.yaml');
      if (!existsSync(configPath)) {
        const err = new Error('litellm.yaml not found');
        err.status = 404;
        throw err;
      }

      const raw = readFileSync(configPath, 'utf8');
      const parsed = parse(raw);

      const phase = telemetryStore
        ? telemetryStore.getSnapshot().liveState?.phase || 'IDLE'
        : 'IDLE';

      const PHASE_TIER_MAP = {
        PLAN: 'openai/tier-4-planner',
        DISCOVER: 'openai/tier-4-planner',
        EXEC: 'openai/tier-3-builder',
        SWARM: 'openai/tier-3-builder',
        FIX: 'openai/tier-2-hunter',
        QA: 'openai/tier-2-hunter',
        VISUAL_QA: 'openai/tier-2-hunter',
        REFLECT: 'openai/tier-2-hunter',
        COMMIT: 'openai/tier-1-trivial',
        SYNC: 'openai/tier-1-trivial',
        IDLE: 'openai/tier-1-trivial',
      };

      const activeModelName = PHASE_TIER_MAP[phase] || 'openai/tier-4-planner';
      const chain = [];

      const primary = parsed.model_list?.find((m) => m.model_name === activeModelName);
      if (primary) {
        let pModel = primary.litellm_params?.model || activeModelName;
        let pProvider = primary.model_info?.provider || 'unknown';
        pProvider = resolveUpstreamProvider(pModel, pProvider);
        if (pProvider === 'opencode') {
          if (pModel.startsWith('openai/')) {
            pModel = pModel.replace('openai/', 'opencode/');
          }
        }
        chain.push({
          alias: activeModelName,
          model: pModel,
          provider: pProvider,
          rpm: primary.litellm_params?.rpm || null,
          timeout: primary.litellm_params?.timeout || null,
          context: primary.model_info?.context_window || null,
        });
      }

      const fallbackObj = parsed.router_settings?.fallbacks?.find(
        (fb) => typeof fb === 'object' && fb !== null && fb[activeModelName],
      );
      if (fallbackObj) {
        const fallbacks = fallbackObj[activeModelName];
        if (Array.isArray(fallbacks)) {
          for (const fbAlias of fallbacks) {
            const m = parsed.model_list?.find((x) => x.model_name === fbAlias);
            if (m) {
              let fbModel = m.litellm_params?.model || fbAlias;
              let fbProvider = m.model_info?.provider || 'unknown';
              fbProvider = resolveUpstreamProvider(fbModel, fbProvider);
              if (fbProvider === 'opencode') {
                if (fbModel.startsWith('openai/')) {
                  fbModel = fbModel.replace('openai/', 'opencode/');
                }
              }
              chain.push({
                alias: fbAlias,
                model: fbModel,
                provider: fbProvider,
                rpm: m.litellm_params?.rpm || null,
                timeout: m.litellm_params?.timeout || null,
                context: m.model_info?.context_window || null,
              });
            }
          }
        }
      }

      res.json(chain);
    } catch (e) {
      next(e);
    }
  });

  router.get('/sota-stats', (req, res, next) => {
    try {
      const stats = { cacheEntries: 0, distillationSamples: 0 };
      const cachePath = join(HYDRA_DIR, 'semantic-cache.json');
      if (existsSync(cachePath)) {
        const c = JSON.parse(readFileSync(cachePath, 'utf8'));
        stats.cacheEntries = Object.keys(c.entries || {}).length;
      }
      const distPath = join(HYDRA_DIR, 'distillation-dataset.jsonl');
      if (existsSync(distPath)) {
        const lines = readFileSync(distPath, 'utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0);
        stats.distillationSamples = lines.length;
      }
      res.json(stats);
    } catch (e) {
      next(e);
    }
  });

  router.get('/provider-keys', (req, res) => {
    const PROVDERS = [
      { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY' },
      { id: 'groq', label: 'Groq', envKey: 'GROQ_API_KEY' },
      { id: 'mistral', label: 'Mistral', envKey: 'MISTRAL_API_KEY' },
      { id: 'kilo', label: 'Kilo Gateway', envKey: 'KILO_API_KEY' },
      { id: 'cerebras', label: 'Cerebras', envKey: 'CEREBRAS_API_KEY' },
      { id: 'nvidia', label: 'NVIDIA NIM', envKey: 'NVIDIA_API_KEY' },
    ];
    res.json(
      PROVDERS.map((p) => ({
        id: p.id,
        label: p.label,
        configured: !!config.litellm.providerKeys[p.id],
      })),
    );
  });

  return router;
}
