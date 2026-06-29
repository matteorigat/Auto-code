import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import config from '../config/index.js';
import type { BridgeBot } from '../bot/telegram-bot.js';

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
  language?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
  inline_message_id?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

export class PollingManager {
  readonly bot: BridgeBot;
  readonly handleMessage: (msg: TelegramMessage) => Promise<void>;
  readonly handleCallback: (cb: TelegramCallbackQuery) => Promise<void>;
  readonly offsetPath: string;

  offset: number = 0;
  isShuttingDown: boolean = false;

  constructor(
    bot: BridgeBot,
    handleMessage: (msg: TelegramMessage) => Promise<void>,
    handleCallback: (cb: TelegramCallbackQuery) => Promise<void>,
  ) {
    this.bot = bot;
    this.handleMessage = handleMessage;
    this.handleCallback = handleCallback;
    this.offsetPath = join(config.system.rootDir, '.hydra', 'telegram-offset.json');
    this.loadOffset();
  }

  private loadOffset(): void {
    try {
      if (existsSync(this.offsetPath)) {
        this.offset = JSON.parse(readFileSync(this.offsetPath, 'utf-8')).offset || 0;
      }
    } catch {
      console.error('Error loading Telegram offset');
    }
  }

  saveOffset(newOffset: number): void {
    this.offset = newOffset;
    try {
      const d = dirname(this.offsetPath);
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
      writeFileSync(this.offsetPath, JSON.stringify({ offset: newOffset }), 'utf-8');
    } catch {
      console.error('Error saving Telegram offset');
    }
  }

  async poll(): Promise<void> {
    if (this.isShuttingDown) return;
    try {
      const data = (await this.bot.callApi('getUpdates', {
        offset: this.offset,
        timeout: config.telegram.pollingTimeoutSec,
        allowed_updates: ['message', 'callback_query'],
      })) as unknown as GetUpdatesResponse;

      if (data.ok && data.result) {
        for (const upd of data.result) {
          try {
            if (upd.message) {
              await this.handleMessage(upd.message);
            } else if (upd.callback_query) {
              await this.handleCallback(upd.callback_query);
            }
          } catch {
            console.error('Update processing error');
          }
          this.saveOffset(upd.update_id + 1);
        }
      }
    } catch {
      console.error('Poll error');
    }
    if (!this.isShuttingDown) setTimeout(() => this.poll(), 300);
  }

  stop(): void {
    this.isShuttingDown = true;
  }
}
