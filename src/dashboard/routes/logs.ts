import { Router, Request, Response } from 'express';
import type { TelemetryStore } from '../telemetry-store.js';
import type { TelemetryEventInput } from '../telemetry-client.js';

interface RouterDeps {
  telemetryStore: TelemetryStore;
}

export function createLogsRouter({ telemetryStore }: RouterDeps) {
  const router = Router();

  router.delete('/logs', (req: Request, res: Response) => {
    const collector = telemetryStore.collector;
    collector.db.prepare('DELETE FROM events').run();
    telemetryStore.ingest({
      type: 'log',
      level: 'info',
      source: 'dashboard',
      message: 'All logs cleared via dashboard',
    });
    res.json({ status: 'ok', cleared: true });
  });

  router.get('/logs', (req: Request, res: Response) => {
    const { limit, level, source, type, since } = req.query;
    const collector = telemetryStore.collector;
    const events = collector.queryEvents({
      limit: Math.min(parseInt(limit as string) || 100, 1000),
      level: level as string | undefined,
      source: source as string | undefined,
      type: type as string | undefined,
      since: since as string | undefined,
    });
    res.json({ events, hasMore: events.length >= (parseInt(limit as string) || 100) });
  });

  router.post('/internal/telemetry', (req: Request, res: Response) => {
    const { events } = req.body || {};
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array required' });
    }
    telemetryStore.ingest(events);
    res.json({ status: 'ok', accepted: events.length });
  });

  router.post('/internal/log', (req: Request, res: Response) => {
    const { level, source, message, data } = req.body || {};
    telemetryStore.ingest({
      type: 'log',
      level: level || 'info',
      source: source || 'external',
      message: message || '-',
      data,
    } as TelemetryEventInput);
    res.json({ status: 'ok' });
  });

  router.post('/internal/log-call', (req: Request, res: Response) => {
    telemetryStore.ingest({
      type: 'model.call',
      level: 'info',
      source: 'model-router',
      message: `${req.body.provider}/${req.body.modelId}`,
      data: req.body,
    } as TelemetryEventInput);
    res.json({ status: 'ok' });
  });

  return router;
}
