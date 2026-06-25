import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import config from '../config/index.mjs';

export class PollingManager {
  constructor(bot, handleMessage, handleCallback) {
    this.bot = bot;
    this.handleMessage = handleMessage;
    this.handleCallback = handleCallback;
    this.offsetPath = join(config.system.rootDir, '.hydra', 'telegram-offset.json');
    this.offset = 0;
    this.isShuttingDown = false;
    this._loadOffset();
  }

  _loadOffset() {
    try {
      if (existsSync(this.offsetPath)) {
        this.offset = JSON.parse(readFileSync(this.offsetPath, 'utf-8')).offset || 0;
      }
    } catch (e) {
      console.error('Error loading Telegram offset:', e.message);
    }
  }

  saveOffset(newOffset) {
    this.offset = newOffset;
    try {
      const dir = dirname(this.offsetPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.offsetPath, JSON.stringify({ offset: newOffset }), 'utf-8');
    } catch (e) {
      console.error('Error saving Telegram offset:', e.message);
    }
  }

  async poll() {
    if (this.isShuttingDown) return;
    try {
      const data = await this.bot.callApi('getUpdates', {
        offset: this.offset,
        timeout: config.telegram.pollingTimeoutSec,
        allowed_updates: ['message', 'callback_query'],
      });
      if (data.ok && data.result) {
        for (const upd of data.result) {
          try {
            if (upd.message) {
              await this.handleMessage(upd.message);
            } else if (upd.callback_query) {
              await this.handleCallback(upd.callback_query);
            }
          } catch (e) {
            console.error('Update processing error:', e);
          }
          /* Save offset AFTER successful processing — so crashed updates are retried */
          this.saveOffset(upd.update_id + 1);
        }
      }
    } catch (err) {
      console.error('poll error:', err.message);
    }
    if (!this.isShuttingDown) setTimeout(() => this.poll(), 300);
  }

  stop() {
    this.isShuttingDown = true;
  }
}
