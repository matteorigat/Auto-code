import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDurableState } from '../../src/core/durable-state.mjs';
import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => ({
  open: vi.fn().mockResolvedValue({ close: vi.fn() }),
  unlink: vi.fn().mockResolvedValue(),
}));

describe('DurableState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads default state when file missing', async () => {
    fs.existsSync.mockReturnValue(false);
    const state = getDurableState('/test/path');
    const data = await state.load();

    expect(data.phase).toBe('IDLE');
    expect(data.attempt).toBe(0);
    expect(data.lastPhase).toBeNull();
  });

  it('transitions state correctly', async () => {
    fs.existsSync.mockReturnValue(false);
    const state = getDurableState('/test/path');
    await state.load(); // init

    await state.transition('PLAN', { newField: true });
    const data = state.get();

    expect(data.phase).toBe('PLAN');
    expect(data.lastPhase).toBe('IDLE');
    expect(data.eventId).toBe(1);
    expect(data.newField).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});
