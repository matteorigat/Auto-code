import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDurableState } from '../../src/core/durable-state.js';
import { EventStream } from '../../src/core/event-stream.js';
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
  open: vi
    .fn()
    .mockResolvedValue({ close: vi.fn() } as Partial<import('node:fs/promises').FileHandle>),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

describe('DurableState', () => {
  let mockStream: EventStream;
  beforeEach(() => {
    mockStream = new EventStream('/test/path');
    vi.clearAllMocks();
  });

  it('loads default state when file missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const state = getDurableState('/test/path', mockStream);
    const data = await state.load();

    expect(data.phase).toBe('IDLE');
    expect(data.attempt).toBe(0);
    expect(data.lastPhase).toBeNull();
  });

  it('transitions state correctly', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const state = getDurableState('/test/path', mockStream);
    await state.load(); // init

    await state.transition('PLAN', { currentTaskId: 'task-123' });
    const data = state.get();

    expect(data!.phase).toBe('PLAN');
    expect(data!.lastPhase).toBe('IDLE');
    expect(data!.eventId).toBe(1);
    expect(data!.currentTaskId).toBe('task-123');
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('recovers from backup if main checkpoint is corrupted', async () => {
    const state = getDurableState('/test/path/backup', mockStream);

    // Simulate existsSync returning true for main checkpoint and backup file
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('loop-checkpoint.json')) return true;
      if (p.includes('loop-checkpoint.json.bak')) return true;
      return false;
    });

    // Simulate corrupted main checkpoint (JSON parse failure)
    vi.mocked(fs.readFileSync).mockImplementation((path: fs.PathOrFileDescriptor) => {
      const p = String(path);
      if (p.includes('loop-checkpoint.json.bak')) {
        return JSON.stringify({ phase: 'QA', attempt: 1, lastPhase: 'EXEC', eventId: 4 });
      }
      if (p.includes('loop-checkpoint.json')) {
        throw new Error('Corrupted JSON syntax error');
      }
      return '';
    });

    const data = await state.load();
    expect(data.phase).toBe('QA');
    expect(data.attempt).toBe(1);
    expect(data.lastPhase).toBe('EXEC');
    expect(data.eventId).toBe(4);

    // Verify it restored the backup to the main file
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('loop-checkpoint.json'),
      expect.stringContaining('"phase":"QA"'),
      'utf-8',
    );
  });
});
