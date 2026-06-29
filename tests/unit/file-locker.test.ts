import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileLocker } from '../../src/core/file-locker.js';
import * as fsPromises from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  open: vi.fn(),
  unlink: vi.fn(),
}));

describe('FileLocker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should acquire lock successfully', async () => {
    vi.mocked(fsPromises.open).mockResolvedValue({
      close: vi.fn(),
    } as Partial<fsPromises.FileHandle> as fsPromises.FileHandle);
    const locker = new FileLocker('/test');

    const lockPath = await locker.acquire('resource');
    expect(lockPath).toContain('.hydra/resource.lock');
    expect(fsPromises.open).toHaveBeenCalledWith(lockPath, 'wx');
  });

  it('should retry if file exists', async () => {
    const mockClose = vi.fn();
    const errorExist = new Error('EEXIST') as Error & { code?: string };
    errorExist.code = 'EEXIST';

    vi.mocked(fsPromises.open)
      .mockRejectedValueOnce(errorExist)
      .mockResolvedValueOnce({
        close: mockClose,
      } as Partial<fsPromises.FileHandle> as fsPromises.FileHandle);

    const locker = new FileLocker('/test');
    const lockPath = await locker.acquire('resource', 2, 1);

    expect(fsPromises.open).toHaveBeenCalledTimes(2);
    expect(lockPath).toBeDefined();
  });
});
