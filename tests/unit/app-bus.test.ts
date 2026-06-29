import { describe, it, expect, vi } from 'vitest';
import { getAppBus } from '../../src/core/app-bus.js';

describe('AppBus', () => {
  it('should emit and listen to events', () => {
    const appBus = getAppBus();
    const mockListener = vi.fn();
    appBus.on('test.event', mockListener);

    appBus.emit('test.event', { payload: 'data' });

    expect(mockListener).toHaveBeenCalledWith({ payload: 'data' });
  });

  it('should remove listeners', () => {
    const appBus = getAppBus();
    const mockListener = vi.fn();
    appBus.on('test.event2', mockListener);
    appBus.off('test.event2', mockListener);

    appBus.emit('test.event2', { payload: 'data' });

    expect(mockListener).not.toHaveBeenCalled();
  });
});
