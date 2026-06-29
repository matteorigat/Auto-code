import config from '../config/index.js';

const DASHBOARD_URL = `http://127.0.0.1:${config.dashboard.port}`;

async function _post(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${DASHBOARD_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      console.warn(`[dash-client] POST ${path} -> ${res.status}`);
    }
    return res.ok;
  } catch {
    return false;
  }
}

export function logCall(data: unknown): Promise<boolean> {
  return _post('/api/internal/log-call', data);
}

export function sendLog(
  level: string,
  source: string,
  message: string,
  data: unknown = null,
): Promise<boolean> {
  return _post('/api/internal/log', { level, source, message, data });
}

export function healthPing(services: unknown): Promise<boolean> {
  return _post('/api/internal/health-ping', services);
}
