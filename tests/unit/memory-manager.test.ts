import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryManager } from '../../src/core/memory-manager.js';
import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    statSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

describe('MemoryManager', () => {
  let memory: MemoryManager;

  beforeEach(() => {
    vi.clearAllMocks();
    memory = new MemoryManager('/test/project');
  });

  it('initializes event stream files', () => {
    expect(memory.jsonlPath).toContain('event-stream.jsonl');
  });

  it('adds and loads patterns with deduplication', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        { _norm: 'existing pattern', text: 'Existing pattern', createdAt: '2023-01-01' },
      ]),
    );

    const result1 = memory.addPattern('Existing pattern');
    expect(result1).toBe(false); // Duplicated

    const result2 = memory.addPattern('New pattern');
    expect(result2).toBe(true); // Added
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});
