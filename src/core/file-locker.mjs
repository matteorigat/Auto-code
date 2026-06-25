import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export class FileLocker {
  constructor(projectPath) {
    this.lockDir = join(projectPath, '.hydra');
  }

  async acquire(resourceName, maxRetries = 50, retryDelayMs = 100) {
    const lockPath = join(this.lockDir, `${resourceName}.lock`);
    for (let i = 0; i < maxRetries; i++) {
      try {
        const fh = await open(lockPath, 'wx');
        await fh.close();
        return lockPath;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
    throw new Error(`Timeout acquiring lock for ${resourceName}`);
  }

  async release(lockPath) {
    try {
      await unlink(lockPath);
    } catch (e) {
      // Ignore
    }
  }

  async withLock(resourceName, fn) {
    const lockPath = await this.acquire(resourceName);
    try {
      return await fn();
    } finally {
      await this.release(lockPath);
    }
  }
}
