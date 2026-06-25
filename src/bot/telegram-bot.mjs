import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramApiClient } from './telegram-api.mjs';

const CHUNK_MAX = 3500;
const RATE_LIMIT_WAIT = 1000;

export class BridgeBot {
  constructor(token, statePath, allowedUsers) {
    this.token = token;
    this.api = new TelegramApiClient(token);
    this.statePath = statePath;
    this.allowedUsers = allowedUsers;
    this.chatState = {};
    this.chatQueues = new Map();
    this.typingTimers = {};
    this._saveTimer = null;
    this._pendingTelegram = [];
  }

  async callApi(method, payload = {}) {
    return this.api.callApi(method, payload);
  }

  _loadChatState() {
    try {
      const raw = readFileSync(this.statePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  _saveChatState() {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.chatState));
    } catch (e) {
      console.error('[BridgeBot] Failed to save state', e);
    }
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveChatState();
    }, 500);
  }

  getState(cid) {
    const cidStr = String(cid);
    if (!this.chatState[cidStr]) {
      const saved = this._loadChatState();
      this.chatState[cidStr] = saved[cidStr] || {
        project: 'bridge',
        model: null,
        sessionId: null,
        wizard: null,
        msgIds: [],
        lastBotMsgId: null,
        statusMsgId: null,
      };
    }
    if (!this.chatState[cidStr]._proxy) {
      const raw = this.chatState[cidStr];
      const self = this;
      this.chatState[cidStr] = new Proxy(raw, {
        set(target, prop, value) {
          target[prop] = value;
          self._scheduleSave();
          return true;
        },
        deleteProperty(target, prop) {
          delete target[prop];
          self._scheduleSave();
          return true;
        },
      });
    }
    return this.chatState[cidStr];
  }

  persistMsgId(chatId, messageId, type = 'bot') {
    const st = this.getState(chatId);
    const ids = st.msgIds || [];
    if (!ids.find((m) => m.id === messageId)) {
      st.msgIds = [...ids, { id: messageId, type }];
    }
    if (type === 'bot') st.lastBotMsgId = messageId;
    this._scheduleSave();
  }

  deleteMsgIds(chatId, ids) {
    const st = this.getState(chatId);
    st.msgIds = (st.msgIds || []).filter((m) => !ids.includes(m.id));
  }

  _splitMarkdownSafe(text) {
    if (text.length <= CHUNK_MAX) return [text];
    const chunks = [];
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

  async processChatQueue(chatId) {
    const queue = this.chatQueues.get(chatId);
    if (!queue || queue.isSending || queue.items.length === 0) return;
    queue.isSending = true;
    const batch = queue.items.splice(0, queue.items.length);

    try {
      const text = batch.map((i) => i.text).join('\n\n');
      const st = this.chatState[String(chatId)];
      const opt = batch[batch.length - 1].opt;
      const chunks = this._splitMarkdownSafe(text);

      for (let i = 0; i < chunks.length; i++) {
        const res = await this.callApi('sendMessage', {
          chat_id: chatId,
          text: chunks[i],
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
        if (res.ok && res.result?.message_id && st) {
          this.persistMsgId(chatId, res.result.message_id);
        }
        if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT));
      }
      batch.forEach((i) => i.resolve());
    } catch (e) {
      if (e.description?.includes('429')) {
        const retryAfter = e.parameters?.retry_after || 5;
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

  async send(chatId, text, opt = {}) {
    if (!text) return;
    return new Promise((resolve, reject) => {
      const cid = String(chatId);
      if (!this.chatQueues.has(cid)) {
        this.chatQueues.set(cid, { items: [], isSending: false });
      }
      const queue = this.chatQueues.get(cid);
      queue.items.push({ text, opt, resolve, reject });
      if (!queue.isSending) {
        setTimeout(() => this.processChatQueue(cid), 100);
      }
    });
  }

  async updateMessage(chatId, messageId, text, opt = {}) {
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
        const desc = res.description || '';
        if (desc.includes('message is not modified')) return;
        if (desc.includes('not found') || desc.includes("message can't be edited")) {
          return this.send(chatId, text, opt);
        }
      }
      return res;
    } catch (e) {
      console.error('[BridgeBot] editMessageText error:', e.message);
    }
  }

  async deleteMessage(chatId, messageId) {
    try {
      await this.callApi('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch (e) {
      if (!String(e).includes('message to delete not found')) {
        console.error('[BridgeBot] deleteMessage error:', e.message);
      }
    }
  }

  async sendOrUpdate(chatId, text, opt = {}) {
    const st = this.getState(chatId);
    if (st.lastBotMsgId && Array.isArray(st.msgIds) && st.msgIds.length > 0) {
      const lastBot = st.msgIds.filter((m) => m.type === 'bot').pop();
      if (lastBot) {
        return this.updateMessage(chatId, lastBot.id, text, opt);
      }
    }
    await this.send(chatId, text, opt);
  }

  async deleteAllBotMessages(chatId) {
    const st = this.getState(chatId);
    const ids = [...(st.msgIds || [])];
    const botIds = ids.filter((m) => m.type === 'bot');
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

  async sendAction(chatId, action = 'typing') {
    try {
      await this.callApi('sendChatAction', { chat_id: chatId, action });
    } catch (e) {
      console.error('[BridgeBot] sendChatAction error:', e.message);
    }
  }

  startTyping(chatId) {
    this.stopTyping(chatId);
    this.sendAction(chatId, 'typing').catch(() => {});
    this.typingTimers[chatId] = setInterval(() => {
      this.sendAction(chatId, 'typing').catch(() => {});
    }, 4000);
  }

  stopTyping(chatId) {
    if (this.typingTimers[chatId]) {
      clearInterval(this.typingTimers[chatId]);
      delete this.typingTimers[chatId];
    }
  }

  stopAllTyping() {
    for (const cid of Object.keys(this.typingTimers)) {
      this.stopTyping(Number(cid));
    }
  }

  persist() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveChatState();
  }

  inlineKeyboard(rows) {
    return JSON.stringify({ inline_keyboard: rows });
  }

  handleIPCMessage(msg) {
    if (msg.type !== 'telegram' || !msg.action) return;
    const { action, payload } = msg;
    const method = {
      sendMessage: 'send',
      editMessageText: 'updateMessage',
      deleteMessage: 'deleteMessage',
      sendChatAction: 'sendAction',
      sendOrUpdate: 'sendOrUpdate',
    }[action];
    if (this[method]) {
      const { chatId, ...rest } = payload || {};
      if (!chatId && action === 'sendMessage') return;
      const cid = chatId || msg.chatId;
      if (!cid) return;
      if (method === 'send' || method === 'sendOrUpdate') {
        return this[method](cid, rest.text || '', rest);
      }
      if (method === 'updateMessage' || method === 'deleteMessage') {
        return this[method](cid, rest.messageId, rest.text || '', rest);
      }
      if (method === 'sendAction') {
        return this[method](cid, rest.action || 'typing');
      }
      return this[method](cid, rest);
    }
    this.callApi(action, { chat_id: msg.chatId, ...payload }).catch(() => {});
  }
}
