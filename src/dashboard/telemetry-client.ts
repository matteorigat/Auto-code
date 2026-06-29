import config from '../config/index.js';
import { uuidv7 } from './utils.js';

const DASHBOARD_URL = `http://127.0.0.1:${config.dashboard?.port || 8081}`;

export interface TelemetryEvent {
  id: string;
  ts: string;
  type: string;
  level: string;
  source: string;
  message: string;
  data: Record<string, unknown> | null;
  sessionId: string | null;
  taskId: string | null;
  projectId: string | null;
}

export type TelemetryEventInput = Partial<TelemetryEvent> &
  Pick<TelemetryEvent, 'source' | 'message'>;

interface EmitOptions {
  level?: string;
  data?: Record<string, unknown> | undefined;
  sessionId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
}

export class TelemetryClient {
  baseUrl: string;
  token: string | null;
  _queue: TelemetryEvent[];
  _flushing: boolean;
  _maxQueue: number;
  _flushTimer: ReturnType<typeof setTimeout> | null;

  constructor(baseUrl: string = DASHBOARD_URL, token: string | null = null) {
    this.baseUrl = baseUrl;
    this.token = token || config.dashboard?.token || null;
    this._queue = [];
    this._flushing = false;
    this._maxQueue = 500;
    this._flushTimer = null;
  }

  emit(type: string, source: string, message: string, opts: EmitOptions = {}): void {
    const event: TelemetryEvent = {
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

  info(source: string, msg: string, data?: Record<string, unknown>): void {
    this.emit('log', source, msg, { level: 'info', data: data ?? undefined });
  }
  warn(source: string, msg: string, data?: Record<string, unknown>): void {
    this.emit('log', source, msg, { level: 'warn', data: data ?? undefined });
  }
  error(source: string, msg: string, data?: Record<string, unknown>): void {
    this.emit('log', source, msg, { level: 'error', data: data ?? undefined });
  }

  logCall(callData: Record<string, unknown>): void {
    this.emit('model.call', 'litellm', 'Model call', { data: callData });
  }
  healthPing(services: Record<string, unknown>): void {
    this.emit('process.status', 'bridge', 'Health ping', { data: services });
  }

  async _flush(): Promise<void> {
    if (this._flushing || this._queue.length === 0) return;
    this._flushing = true;
    const batch = this._queue.splice(0, 50);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
      await fetch(`${this.baseUrl}/api/internal/telemetry`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      this._queue.unshift(...batch);
      if (this._queue.length > this._maxQueue) {
        this._queue.splice(this._maxQueue);
      }
    } finally {
      this._flushing = false;
      if (this._queue.length > 0) {
        setTimeout(() => this._flush(), 2000);
      }
    }
  }
}

// Singleton instance for import convenience
let _instance: TelemetryClient | null = null;
export function getTelemetryClient() {
  if (!_instance) _instance = new TelemetryClient();
  return _instance;
}

export function sendLog(
  level: string,
  source: string,
  message: string,
  data: Record<string, unknown> | null = null,
): void {
  getTelemetryClient().emit('log', source, message, { level, data: data ?? undefined });
}

export function logCall(data: Record<string, unknown>): void {
  getTelemetryClient().logCall(data);
}

export function healthPing(services: Record<string, unknown>): void {
  getTelemetryClient().healthPing(services);
}
