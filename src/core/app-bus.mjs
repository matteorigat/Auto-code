import { EventEmitter } from 'node:events';

/**
 * Application-wide event bus for cross-cutting concerns.
 * Replaces direct imports of telemetry, logging, and metrics from core modules.
 *
 * Events:
 *   "telemetry"  - { type, source, message, data? }
 *   "log"        - { level, module, message, meta? }
 *   "metric"     - { name, value, tags? }
 */
class AppBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  telemetry(type, source, message, data) {
    this.emit('telemetry', { type, source, message, data });
  }
}

let _instance;
export function getAppBus() {
  if (!_instance) _instance = new AppBus();
  return _instance;
}
