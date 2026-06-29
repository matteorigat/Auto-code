import { EventEmitter } from 'node:events';
class AppBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(50);
    }
    telemetry(type, source, message, data) {
        this.emit('telemetry', { type, source, message, data });
    }
}
let instance;
export function getAppBus() {
    if (!instance) {
        instance = new AppBus();
    }
    return instance;
}
export function resetAppBus() {
    instance = undefined;
}
