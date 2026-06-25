import { Router } from 'express';

export function createLogsRouter({ telemetryStore }) {
  const router = Router();

  router.get('/logs', (req, res) => {
    const { limit, level, source, type, since } = req.query;
    const events = telemetryStore.collector.queryEvents({
      limit: Math.min(parseInt(limit) || 100, 1000),
      level,
      source,
      type,
      since,
    });
    res.json({ events, hasMore: events.length >= (parseInt(limit) || 100) });
  });

  // Unified telemetry ingest
  router.post('/internal/telemetry', (req, res) => {
    const { events } = req.body || {};
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array required' });
    }
    telemetryStore.ingest(events);
    res.json({ status: 'ok', accepted: events.length });
  });

  // Backward-compatible aliases
  router.post('/internal/log', (req, res) => {
    const { level, source, message, data } = req.body || {};
    telemetryStore.ingest({
      type: 'log',
      level: level || 'info',
      source: source || 'external',
      message: message || '-',
      data,
    });
    res.json({ status: 'ok' });
  });

  router.post('/internal/log-call', (req, res) => {
    telemetryStore.ingest({
      type: 'model.call',
      level: 'info',
      source: 'litellm',
      message: `${req.body.provider}/${req.body.modelId}`,
      data: req.body,
    });
    res.json({ status: 'ok' });
  });

  return router;
}
