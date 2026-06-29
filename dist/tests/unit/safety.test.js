import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Safety } from '../../src/core/safety.js';
import * as fs from 'node:fs';
vi.mock('node:fs', async () => {
    const actual = await vi.importActual('node:fs');
    return {
        ...actual,
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
    };
});
describe('Safety', () => {
    let safety;
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        // Setup process.env for max budget
        process.env.LOOP_DAILY_COST_LIMIT = '1.0';
        safety = new Safety('/test/project');
    });
    it('tracks cost and respects budget', () => {
        // @ts-expect-error - Calling private method for testing
        safety.resetCostWindow();
        expect(safety.isOverBudget()).toBe(false);
        safety.addCost(0.5);
        expect(safety.isOverBudget()).toBe(false);
        safety.addCost(15.0); // Default budget is 10.0
        expect(safety.isOverBudget()).toBe(true);
    });
    it('implements circuit breaker pattern', () => {
        safety.recordApiFailure(500);
        expect(safety.isCircuitOpen()).toBe(false);
        safety.recordApiFailure(500);
        safety.recordApiFailure(500);
        expect(safety.isCircuitOpen()).toBe(true);
        safety.recordApiSuccess();
        safety.recordApiSuccess();
        safety.recordApiSuccess();
        expect(safety.isCircuitOpen()).toBe(false);
    });
});
