import { EventEmitter } from 'node:events';

export interface TelemetryEvent {
  type: string;
  source: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogEvent {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  module: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface MetricEvent {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

class AppBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  telemetry(type: string, source: string, message: string, data?: Record<string, unknown>): void {
    this.emit('telemetry', { type, source, message, data });
  }
}

let instance: AppBus | undefined;

export function getAppBus(): AppBus {
  if (!instance) {
    instance = new AppBus();
  }
  return instance;
}

export function resetAppBus(): void {
  instance = undefined;
}
