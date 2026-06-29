import config from '../config/index.js';
import { uuidv7 } from './utils.js';
const DASHBOARD_URL = `http://127.0.0.1:${config.dashboard?.port || 8081}`;
export class TelemetryClient {
    baseUrl;
    token;
    _queue;
    _flushing;
    _maxQueue;
    _flushTimer;
    constructor(baseUrl = DASHBOARD_URL, token = null) {
        this.baseUrl = baseUrl;
        this.token = token || config.dashboard?.token || null;
        this._queue = [];
        this._flushing = false;
        this._maxQueue = 500;
        this._flushTimer = null;
    }
    emit(type, source, message, opts = {}) {
        const event = {
            id: uuidv7(),
            type,
            ts: new Date().toISOString(),
            level: opts.level || 'info',
            source,
            message,
            data: opts.data || null,
            sessionId: opts.sessionId || null,
            taskId: opts.taskId || null,
            projectId: opts.projectId || null,
        };
        this._queue.push(event);
        if (!this._flushTimer) {
            this._flushTimer = setTimeout(() => {
                this._flushTimer = null;
                this._flush();
            }, 100);
        }
    }
    info(source, msg, data) {
        this.emit('log', source, msg, { level: 'info', data: data ?? undefined });
    }
    warn(source, msg, data) {
        this.emit('log', source, msg, { level: 'warn', data: data ?? undefined });
    }
    error(source, msg, data) {
        this.emit('log', source, msg, { level: 'error', data: data ?? undefined });
    }
    logCall(callData) {
        this.emit('model.call', 'omniroute', 'Model call', { data: callData });
    }
    healthPing(services) {
        this.emit('process.status', 'bridge', 'Health ping', { data: services });
    }
    async _flush() {
        if (this._flushing || this._queue.length === 0)
            return;
        this._flushing = true;
        const batch = this._queue.splice(0, 50);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (this.token)
                headers['Authorization'] = `Bearer ${this.token}`;
            await fetch(`${this.baseUrl}/api/internal/telemetry`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ events: batch }),
                signal: AbortSignal.timeout(3000),
            });
        }
        catch {
            this._queue.unshift(...batch);
            if (this._queue.length > this._maxQueue) {
                this._queue.splice(this._maxQueue);
            }
        }
        finally {
            this._flushing = false;
            if (this._queue.length > 0) {
                setTimeout(() => this._flush(), 2000);
            }
        }
    }
}
// Singleton instance for import convenience
let _instance = null;
export function getTelemetryClient() {
    if (!_instance)
        _instance = new TelemetryClient();
    return _instance;
}
export function sendLog(level, source, message, data = null) {
    getTelemetryClient().emit('log', source, message, { level, data: data ?? undefined });
}
export function logCall(data) {
    getTelemetryClient().logCall(data);
}
export function healthPing(services) {
    getTelemetryClient().healthPing(services);
}
