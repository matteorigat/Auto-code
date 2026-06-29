import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QualityGate } from '../../src/core/quality-gate.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

describe('QualityGate', () => {
  let qg: QualityGate;

  beforeEach(() => {
    qg = new QualityGate('/test/project');
    qg.loadChecks = vi
      .fn()
      .mockReturnValue([{ name: 'test', cmd: 'npm test', timeout: 120, required: true }]);
  });

  it('runs tests and returns results', async () => {
    const cp = await import('node:child_process');

    // First call is docker ps, second is the test execution
    vi.mocked(cp.execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'docker') {
        throw new Error('mock no docker');
      }
      return 'success';
    });

    const result = await qg.run();
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].passed).toBe(true);
    expect(result.results[0].output).toBe('success');
  });

  it('fails if required check fails', async () => {
    const cp = await import('node:child_process');

    vi.mocked(cp.execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'docker') {
        throw new Error('mock no docker');
      }
      const err = new Error('failed') as Error & { status?: number; stdout?: Buffer };
      err.status = 1;
      err.stdout = Buffer.from('error out');
      throw err;
    });

    const result = await qg.run();
    expect(result.passed).toBe(false);
    expect(result.results[0].passed).toBe(false);
    expect(result.results[0].output).toContain('error out');
  });
});
