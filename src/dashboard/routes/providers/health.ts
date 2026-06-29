import { Router, Request, Response, NextFunction } from 'express';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { getUniqueModels, runModelHealthProbe, formatDateTime, type ModelResult } from './utils.js';
import type { MetricsCollector } from '../../collector.js';
import type { TelemetryStore } from '../../telemetry-store.js';

interface HealthDeps {
  collector: MetricsCollector;
  telemetryStore: TelemetryStore;
}

export function createHealthRouter({ collector, telemetryStore }: HealthDeps) {
  const router = Router();

  router.get('/model-health', (req: Request, res: Response, next: NextFunction) => {
    try {
      const results = getUniqueModels(collector);
      res.json(results);
    } catch (e) {
      next(e);
    }
  });

  router.post('/model-health/check', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { model_id, check_all }: { model_id?: string; check_all?: boolean } = req.body;
      const uniqueModels = getUniqueModels(collector);

      if (check_all) {
        const checkPromises = uniqueModels.map(async (m: ModelResult) => {
          const probeName = m.aliases[0] || m.actual_model;
          const checkResult = await runModelHealthProbe(probeName);
          const nowStr = formatDateTime(new Date());
          const lastSuccess = checkResult.status === 'healthy' ? nowStr : null;

          collector.healthTracker.upsertModelHealth(
            m.id,
            m.actual_model,
            checkResult.status,
            checkResult.errorDetails,
            nowStr ?? '',
            lastSuccess ?? '',
          );

          for (const alias of m.aliases) {
            const aliasId = crypto.createHash('sha256').update(alias).digest('hex');
            collector.healthTracker.upsertModelHealth(
              aliasId,
              alias,
              checkResult.status,
              checkResult.errorDetails,
              nowStr ?? '',
              lastSuccess ?? '',
            );
          }
        });

        await Promise.all(checkPromises);
        return res.json({ success: true, message: 'All health checks completed.' });
      } else if (model_id) {
        const targetModel = uniqueModels.find((m: ModelResult) => m.id === model_id);
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
          nowStr ?? '',
          lastSuccess ?? '',
        );

        for (const alias of targetModel.aliases) {
          const aliasId = crypto.createHash('sha256').update(alias).digest('hex');
          collector.healthTracker.upsertModelHealth(
            aliasId,
            alias,
            checkResult.status,
            checkResult.errorDetails,
            nowStr ?? '',
            lastSuccess ?? '',
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
            last_success: (currentDbRow?.last_success as string | null) || null,
          },
        });
      } else {
        return res.status(400).json({ success: false, error: 'Missing model_id or check_all' });
      }
    } catch (e) {
      next(e);
    }
  });

  let _autoCheckTimer: ReturnType<typeof setInterval> | null = null;
  let _autoCheckRunning = false;
  const AUTO_CHECK_INTERVAL = 5 * 60 * 1000;

  async function runAutoHealthCheck(): Promise<void> {
    if (_autoCheckRunning) return;
    _autoCheckRunning = true;
    try {
      const uniqueModels = getUniqueModels(collector);
      const checkPromises = uniqueModels.map(async (m: ModelResult) => {
        const probeName = m.aliases[0] || m.actual_model;
        const checkResult = await runModelHealthProbe(probeName);
        const nowStr = formatDateTime(new Date());
        const lastSuccess = checkResult.status === 'healthy' ? nowStr : 'None';
        collector.healthTracker.upsertModelHealth(
          m.id,
          m.actual_model,
          checkResult.status,
          checkResult.errorDetails,
          nowStr ?? '',
          lastSuccess ?? '',
        );
        for (const alias of m.aliases) {
          const aliasId = crypto.createHash('sha256').update(alias).digest('hex');
          collector.healthTracker.upsertModelHealth(
            aliasId,
            alias,
            checkResult.status,
            checkResult.errorDetails,
            nowStr ?? '',
            lastSuccess ?? '',
          );
        }
      });
      await Promise.allSettled(checkPromises);
    } finally {
      _autoCheckRunning = false;
    }
  }

  router.get('/model-health/auto', (req: Request, res: Response) => {
    res.json({ enabled: _autoCheckTimer !== null, intervalMs: AUTO_CHECK_INTERVAL });
  });

  router.post('/model-health/auto', (req: Request, res: Response) => {
    const { enabled }: { enabled?: boolean } = req.body;
    if (_autoCheckTimer) {
      clearInterval(_autoCheckTimer);
      _autoCheckTimer = null;
    }
    if (enabled) {
      _autoCheckTimer = setInterval(runAutoHealthCheck, AUTO_CHECK_INTERVAL);
      runAutoHealthCheck();
    }
    telemetryStore.ingest({
      type: 'log',
      level: 'info',
      source: 'dashboard',
      message: `Auto health-checks ${enabled ? 'enabled' : 'disabled'}`,
    });
    res.json({ enabled: !!enabled, intervalMs: AUTO_CHECK_INTERVAL });
  });

  return router;
}
