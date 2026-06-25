import { Router } from 'express';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import crypto from 'node:crypto';
import { getUniqueModels, runModelHealthProbe, formatDateTime } from './utils.mjs';

export function createHealthRouter({ collector, telemetryStore }) {
  const router = Router();
  const CONFIG_DIR = join(process.cwd(), 'config');

  router.get('/model-health', (req, res, next) => {
    try {
      const results = getUniqueModels(collector);
      res.json(results);
    } catch (e) {
      next(e);
    }
  });

  router.post('/model-health/check', async (req, res, next) => {
    try {
      const { model_id, check_all } = req.body;
      const uniqueModels = getUniqueModels(collector);

      if (check_all) {
        const checkPromises = uniqueModels.map(async (m) => {
          const probeName = m.aliases[0] || m.actual_model;
          const checkResult = await runModelHealthProbe(probeName);
          const nowStr = formatDateTime(new Date());
          const lastSuccess = checkResult.status === 'healthy' ? nowStr : null;

          collector.healthTracker.upsertModelHealth(
            m.id,
            m.actual_model,
            checkResult.status,
            checkResult.errorDetails,
            nowStr,
            lastSuccess,
          );

          for (const alias of m.aliases) {
            const aliasId = crypto.createHash('sha256').update(alias).digest('hex');
            collector.healthTracker.upsertModelHealth(
              aliasId,
              alias,
              checkResult.status,
              checkResult.errorDetails,
              nowStr,
              lastSuccess,
            );
          }
        });

        await Promise.all(checkPromises);
        return res.json({ success: true, message: 'All health checks completed.' });
      } else if (model_id) {
        const targetModel = uniqueModels.find((m) => m.id === model_id);
        if (!targetModel) {
          return res.status(404).json({ success: false, error: 'Model not found' });
        }

        const probeName = targetModel.aliases[0] || targetModel.actual_model;
        const checkResult = await runModelHealthProbe(probeName);
        const nowStr = formatDateTime(new Date());
        const lastSuccess = checkResult.status === 'healthy' ? nowStr : 'None';

        collector.healthTracker.upsertModelHealth(
          model_id,
          targetModel.actual_model,
          checkResult.status,
          checkResult.errorDetails,
          nowStr,
          lastSuccess,
        );

        for (const alias of targetModel.aliases) {
          const aliasId = crypto.createHash('sha256').update(alias).digest('hex');
          collector.healthTracker.upsertModelHealth(
            aliasId,
            alias,
            checkResult.status,
            checkResult.errorDetails,
            nowStr,
            lastSuccess,
          );
        }

        const currentDbRow = collector.get('SELECT last_success FROM model_health WHERE id = ?', [
          model_id,
        ]);

        return res.json({
          success: true,
          data: {
            id: model_id,
            actual_model: targetModel.actual_model,
            provider: targetModel.provider,
            aliases: targetModel.aliases,
            health_status: checkResult.status,
            error_details: checkResult.errorDetails,
            last_check: nowStr,
            last_success: currentDbRow?.last_success || null,
          },
        });
      } else {
        return res.status(400).json({ success: false, error: 'Missing model_id or check_all' });
      }
    } catch (e) {
      next(e);
    }
  });

  // ── Auto Health-Check Scheduler ──────────────────────────────────────────
  let _autoCheckTimer = null;
  let _autoCheckRunning = false;
  const AUTO_CHECK_INTERVAL = 5 * 60 * 1000; // 5 min

  async function runAutoHealthCheck() {
    if (_autoCheckRunning) return;
    _autoCheckRunning = true;
    try {
      const uniqueModels = getUniqueModels(collector);
      const checkPromises = uniqueModels.map(async (m) => {
        const probeName = m.aliases[0] || m.actual_model;
        const checkResult = await runModelHealthProbe(probeName);
        const nowStr = formatDateTime(new Date());
        const lastSuccess = checkResult.status === 'healthy' ? nowStr : 'None';
        collector.healthTracker.upsertModelHealth(
          m.id,
          m.actual_model,
          checkResult.status,
          checkResult.errorDetails,
          nowStr,
          lastSuccess,
        );
        for (const alias of m.aliases) {
          const aliasId = crypto.createHash('sha256').update(alias).digest('hex');
          collector.healthTracker.upsertModelHealth(
            aliasId,
            alias,
            checkResult.status,
            checkResult.errorDetails,
            nowStr,
            lastSuccess,
          );
        }
      });
      await Promise.allSettled(checkPromises);
    } finally {
      _autoCheckRunning = false;
    }
  }

  router.get('/model-health/auto', (req, res) => {
    res.json({ enabled: _autoCheckTimer !== null, intervalMs: AUTO_CHECK_INTERVAL });
  });

  router.post('/model-health/auto', (req, res) => {
    const { enabled } = req.body;
    if (_autoCheckTimer) {
      clearInterval(_autoCheckTimer);
      _autoCheckTimer = null;
    }
    if (enabled) {
      _autoCheckTimer = setInterval(runAutoHealthCheck, AUTO_CHECK_INTERVAL);
      runAutoHealthCheck();
    }
    telemetryStore?.ingest({
      type: 'log',
      level: 'info',
      source: 'dashboard',
      message: `Auto health-checks ${enabled ? 'enabled' : 'disabled'}`,
    });
    res.json({ enabled: !!enabled, intervalMs: AUTO_CHECK_INTERVAL });
  });

  return router;
}
