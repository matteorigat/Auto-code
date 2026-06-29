import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramApiClient } from './telegram-api.js';

const CHUNK_MAX = 3500;
const RATE_LIMIT_WAIT = 1000;

export interface ChatState {
  project: string;
  model: string | null;
  sessionId: string | null;
  wizard: Record<string, unknown> | null;
  msgIds: MessageIdEntry[];
  lastBotMsgId: number | null;
  statusMsgId: number | null;
}

interface MessageIdEntry {
  id: number;
  type: string;
}

interface QueueItem {
  text: string;
  opt: Record<string, unknown>;
  resolve: (value: undefined) => void;
  reject: (reason: unknown) => void;
}

interface MessageQueue {
  items: QueueItem[];
  isSending: boolean;
}

interface RetryError {
  description?: string;
  parameters?: { retry_after?: number };
}

type BridgeApiResponse = Record<string, unknown>;

export class BridgeBot {
  readonly api: TelegramApiClient;
  readonly statePath: string;
  readonly allowedUsers: number[];

  chatState: Record<string, ChatState> = {};
  readonly chatQueues = new Map<string, MessageQueue>();
  readonly typingTimers: Record<string, ReturnType<typeof setInterval>> = {};
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly token: string,
    statePath: string,
    allowedUsers: number[],
  ) {
    this.api = new TelegramApiClient(token);
    this.statePath = statePath;
    this.allowedUsers = allowedUsers;
  }

  async callApi(method: string, payload: Record<string, unknown> = {}): Promise<BridgeApiResponse> {
    return this.api.callApi(method, payload);
  }

  private loadChatState(): Record<string, ChatState> {
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf-8')) as Record<string, ChatState>;
    } catch {
      return {};
    }
  }

  private saveChatState(): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.chatState));
    } catch {
      console.error('[BridgeBot] Failed to save state');
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveChatState();
    }, 500);
  }

  getState(cid: number | string): ChatState {
    const cidStr = String(cid);
    if (!this.chatState[cidStr]) {
      const saved = this.loadChatState();
      this.chatState[cidStr] = saved[cidStr] ?? {
        project: 'bridge',
        model: null,
        sessionId: null,
        wizard: null,
        msgIds: [],
        lastBotMsgId: null,
        statusMsgId: null,
      };
    }
    return this.chatState[cidStr];
  }

  persistMsgId(chatId: number | string, messageId: number, type: string = 'bot'): void {
    const st = this.getState(chatId);
    if (!st.msgIds.some((m) => m.id === messageId)) {
      st.msgIds = [...st.msgIds, { id: messageId, type }];
    }
    if (type === 'bot') st.lastBotMsgId = messageId;
    this.scheduleSave();
  }

  deleteMsgIds(chatId: number | string, ids: number[]): void {
    const st = this.getState(chatId);
    st.msgIds = st.msgIds.filter((m) => !ids.includes(m.id));
  }

  private splitMarkdownSafe(text: string): string[] {
    if (text.length <= CHUNK_MAX) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= CHUNK_MAX) {
        chunks.push(remaining);
        break;
      }
      let cut = remaining.lastIndexOf('\n\n', CHUNK_MAX);
      if (cut < CHUNK_MAX / 2) {
        cut = remaining.lastIndexOf('\n', CHUNK_MAX);
        if (cut < CHUNK_MAX / 2) cut = CHUNK_MAX;
      }
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    return chunks;
  }

  async processChatQueue(chatId: number | string): Promise<void> {
    const queue = this.chatQueues.get(String(chatId));
    if (!queue || queue.isSending || queue.items.length === 0) return;
    queue.isSending = true;
    const batch = queue.items.splice(0);

    try {
      const text = batch.map((i) => i.text).join('\n\n');
      const st = this.chatState[String(chatId)];
      const chunks = this.splitMarkdownSafe(text);

      for (let i = 0; i < chunks.length; i++) {
        const res = await this.callApi('sendMessage', {
          chat_id: chatId,
          text: chunks[i],
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
        const result = res.result as { message_id?: number } | undefined;
        if (res.ok && result?.message_id && st) {
          this.persistMsgId(chatId, result.message_id);
        }
        if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT));
      }
      batch.forEach((i) => i.resolve(undefined));
    } catch (e: unknown) {
      const err = e as RetryError;
      if (err.description?.includes('429')) {
        const retryAfter = err.parameters?.retry_after ?? 5;
        queue.items.unshift(...batch);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
      } else {
        batch.forEach((i) => i.reject(e));
      }
    }
    queue.isSending = false;
    if (queue.items.length > 0) {
      setTimeout(() => this.processChatQueue(chatId), RATE_LIMIT_WAIT);
    }
  }

  async send(
    chatId: number | string,
    text: string,
    opt: Record<string, unknown> = {},
  ): Promise<void> {
    if (!text) return;
    return new Promise<void>((resolve, reject) => {
      const cid = String(chatId);
      if (!this.chatQueues.has(cid)) {
        this.chatQueues.set(cid, { items: [], isSending: false });
      }
      const queue = this.chatQueues.get(cid)!;
      queue.items.push({ text, opt, resolve, reject });
      if (!queue.isSending) {
        setTimeout(() => this.processChatQueue(cid), 100);
      }
    });
  }

  async updateMessage(
    chatId: number | string,
    messageId: number,
    text: string,
    opt: Record<string, unknown> = {},
  ): Promise<BridgeApiResponse | undefined> {
    try {
      const res = await this.callApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: opt.md !== false ? 'Markdown' : undefined,
        disable_web_page_preview: true,
        ...(opt.reply_markup ? { reply_markup: opt.reply_markup } : {}),
      });
      if (!res.ok) {
        const desc = (res.description as string) || '';
        if (desc.includes('message is not modified')) return;
        if (desc.includes('not found') || desc.includes("message can't be edited")) {
          await this.send(chatId, text, opt);
          return;
        }
      }
      return res;
    } catch {
      console.error('[BridgeBot] editMessageText error');
      return undefined;
    }
  }

  async deleteMessage(chatId: number | string, messageId: number): Promise<void> {
    try {
      await this.callApi('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch {
      // Best-effort: message may already be deleted
    }
  }

  async sendOrUpdate(
    chatId: number | string,
    text: string,
    opt: Record<string, unknown> = {},
  ): Promise<void> {
    const st = this.getState(chatId);
    if (st.lastBotMsgId && st.msgIds.length > 0) {
      const lastBot = st.msgIds.filter((m) => m.type === 'bot').pop();
      if (lastBot) {
        await this.updateMessage(chatId, lastBot.id, text, opt);
        return;
      }
    }
    await this.send(chatId, text, opt);
  }

  async deleteAllBotMessages(chatId: number | string): Promise<void> {
    const st = this.getState(chatId);
    const botIds = st.msgIds.filter((m) => m.type === 'bot');
    for (const m of botIds) {
      await this.deleteMessage(chatId, m.id);
      await new Promise((r) => setTimeout(r, 50));
    }
    this.deleteMsgIds(
      chatId,
      botIds.map((m) => m.id),
    );
    st.lastBotMsgId = null;
  }

  async sendAction(chatId: number | string, action: string = 'typing'): Promise<void> {
    try {
      await this.callApi('sendChatAction', { chat_id: chatId, action });
    } catch {
      // Best-effort
    }
  }

  startTyping(chatId: number | string): void {
    this.stopTyping(chatId);
    this.sendAction(chatId).catch(() => {});
    this.typingTimers[String(chatId)] = setInterval(() => {
      this.sendAction(chatId).catch(() => {});
    }, 4000);
  }

  stopTyping(chatId: number | string): void {
    const timer = this.typingTimers[String(chatId)];
    if (timer) {
      clearInterval(timer);
      delete this.typingTimers[String(chatId)];
    }
  }

  stopAllTyping(): void {
    for (const cid of Object.keys(this.typingTimers)) {
      this.stopTyping(Number(cid));
    }
  }

  persist(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveChatState();
  }

  inlineKeyboard(rows: Record<string, unknown>[][]): string {
    return JSON.stringify({ inline_keyboard: rows });
  }

  handleIPCMessage(msg: Record<string, unknown>): void {
    const action = msg.action as string | undefined;
    if (msg.type !== 'telegram' || !action) return;
    const payload = (msg.payload as Record<string, unknown>) ?? {};

    const methodMap: Record<string, string> = {
      sendMessage: 'send',
      editMessageText: 'updateMessage',
      deleteMessage: 'deleteMessage',
      sendChatAction: 'sendAction',
      sendOrUpdate: 'sendOrUpdate',
    };

    const methodName = methodMap[action];
    if (!methodName) {
      this.callApi(action, { chat_id: msg.chatId, ...payload }).catch(() => {});
      return;
    }

    const { chatId, ...rest } = payload;
    const cid = (chatId ?? msg.chatId) as number | string | undefined;
    if (!cid) return;

    switch (methodName) {
      case 'send':
      case 'sendOrUpdate':
        this.send(cid, (rest.text as string) ?? '', rest);
        break;
      case 'updateMessage':
      case 'deleteMessage':
        (this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[methodName](
          cid,
          rest.messageId,
          (rest.text as string) ?? '',
          rest,
        );
        break;
      case 'sendAction':
        this.sendAction(cid, (rest.action as string) ?? 'typing');
        break;
      default:
        (this as unknown as Record<string, (...args: unknown[]) => void>)[methodName](cid, rest);
    }
  }
}
