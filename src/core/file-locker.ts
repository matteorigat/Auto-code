import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_DIR_NAME = '.hydra';

interface FileError extends Error {
  code?: string;
}

export class FileLocker {
  readonly lockDir: string;

  constructor(projectPath: string) {
    this.lockDir = join(projectPath, LOCK_DIR_NAME);
  }

  async acquire(
    resourceName: string,
    maxRetries: number = 50,
    retryDelayMs: number = 100,
  ): Promise<string> {
    const lockPath = join(this.lockDir, `${resourceName}.lock`);
    for (let i = 0; i < maxRetries; i++) {
      try {
        const fh = await open(lockPath, 'wx');
        await fh.close();
        return lockPath;
      } catch (err: unknown) {
        if ((err as FileError).code !== 'EEXIST') throw err;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    throw new Error(`Timeout acquiring lock for ${resourceName}`);
  }

  async release(lockPath: string): Promise<void> {
    try {
      await unlink(lockPath);
    } catch {
      // Best-effort cleanup: lock may already be released
    }
  }

  async withLock<T>(resourceName: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = await this.acquire(resourceName);
    try {
      return await fn();
    } finally {
      await this.release(lockPath);
    }
  }
}
