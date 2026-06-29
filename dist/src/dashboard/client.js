import config from '../config/index.js';
const DASHBOARD_URL = `http://127.0.0.1:${config.dashboard.port}`;
async function _post(path, body) {
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
    }
    catch {
        return false;
    }
}
export function logCall(data) {
    return _post('/api/internal/log-call', data);
}
export function sendLog(level, source, message, data = null) {
    return _post('/api/internal/log', { level, source, message, data });
}
export function healthPing(services) {
    return _post('/api/internal/health-ping', services);
}
