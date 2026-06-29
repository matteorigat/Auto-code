import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuotaManager } from '../../src/core/quota-manager.js';
import * as fs from 'node:fs';
vi.mock('node:fs', async () => {
    const actual = await vi.importActual('node:fs');
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
    };
});
describe('QuotaManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it('should initialize successfully without config', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        const quota = new QuotaManager('/test.yaml');
        quota.load();
        expect(quota._loaded).toBe(true);
        expect(Object.keys(quota._providers).length).toBe(0);
    });
    it('should consume tokens correctly', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
providers:
  testProvider:
    rpm: 10
`);
        const quota = new QuotaManager('/test.yaml');
        quota.load();
        quota.reportUsage('testProvider');
        expect(quota._count('testProvider', 'rpm')).toBe(1);
    });
});
