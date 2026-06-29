import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import config from '../config/index.js';
export class PollingManager {
    bot;
    handleMessage;
    handleCallback;
    offsetPath;
    offset = 0;
    isShuttingDown = false;
    constructor(bot, handleMessage, handleCallback) {
        this.bot = bot;
        this.handleMessage = handleMessage;
        this.handleCallback = handleCallback;
        this.offsetPath = join(config.system.rootDir, '.hydra', 'telegram-offset.json');
        this.loadOffset();
    }
    loadOffset() {
        try {
            if (existsSync(this.offsetPath)) {
                this.offset = JSON.parse(readFileSync(this.offsetPath, 'utf-8')).offset || 0;
            }
        }
        catch {
            console.error('Error loading Telegram offset');
        }
    }
    saveOffset(newOffset) {
        this.offset = newOffset;
        try {
            const d = dirname(this.offsetPath);
            if (!existsSync(d))
                mkdirSync(d, { recursive: true });
            writeFileSync(this.offsetPath, JSON.stringify({ offset: newOffset }), 'utf-8');
        }
        catch {
            console.error('Error saving Telegram offset');
        }
    }
    async poll() {
        if (this.isShuttingDown)
            return;
        try {
            const data = (await this.bot.callApi('getUpdates', {
                offset: this.offset,
                timeout: config.telegram.pollingTimeoutSec,
                allowed_updates: ['message', 'callback_query'],
            }));
            if (data.ok && data.result) {
                for (const upd of data.result) {
                    try {
                        if (upd.message) {
                            await this.handleMessage(upd.message);
                        }
                        else if (upd.callback_query) {
                            await this.handleCallback(upd.callback_query);
                        }
                    }
                    catch {
                        console.error('Update processing error');
                    }
                    this.saveOffset(upd.update_id + 1);
                }
            }
        }
        catch {
            console.error('Poll error');
        }
        if (!this.isShuttingDown)
            setTimeout(() => this.poll(), 300);
    }
    stop() {
        this.isShuttingDown = true;
    }
}
