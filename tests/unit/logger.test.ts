import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/core/logger.js';

describe('Logger', () => {
  let logSpy: import('vitest').MockInstance;
  let warnSpy: import('vitest').MockInstance;
  let errorSpy: import('vitest').MockInstance;
  let debugSpy: import('vitest').MockInstance;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs info with correct formatting', () => {
    const log = createLogger('TEST');
    log.info('hello world', { key: 'value' });
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    expect(output).toContain('[INFO]');
    expect(output).toContain('[TEST]');
    expect(output).toContain('hello world');
    expect(output).toContain('{"key":"value"}');
  });

  it('logs warn with correct formatting', () => {
    const log = createLogger('TEST');
    log.warn('warning!');
    expect(warnSpy).toHaveBeenCalled();
    const output = warnSpy.mock.calls[0][0];
    expect(output).toContain('[WARN]');
    expect(output).toContain('warning!');
  });

  it('logs error correctly handling Error objects', () => {
    const log = createLogger('TEST');
    const err = new Error('boom');
    log.error('failed', err);
    expect(errorSpy).toHaveBeenCalled();
    const output = errorSpy.mock.calls[0][0];
    expect(output).toContain('[ERROR]');
    expect(output).toContain('failed');
    expect(output).toContain('ERR: boom');
  });

  it('respects DEBUG env var', async () => {
    // Dynamically mock config
    vi.doMock('../../src/config/index.js', () => ({
      default: { system: { debug: false } },
    }));

    // Import after mocking
    const { createLogger } = await import('../../src/core/logger.js');
    const log = createLogger('TEST');

    // Should not log debug by default
    log.debug('hidden');
    expect(debugSpy).not.toHaveBeenCalled();

    // Now mock it as true
    vi.resetModules();
    vi.doMock('../../src/config/index.js', () => ({
      default: { system: { debug: true } },
    }));

    const { createLogger: createLoggerDebug } = await import('../../src/core/logger.js');
    const logDebug = createLoggerDebug('TEST');

    // Should log if DEBUG is set
    logDebug.debug('visible');
    expect(debugSpy).toHaveBeenCalled();
    const output = debugSpy.mock.calls[0][0];
    expect(output).toContain('[DEBUG]');
    expect(output).toContain('visible');
  });
});
