import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class TelegramBot {
  constructor(token, statePath, allowedUsers) {
    this.token = token;
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.statePath = statePath;
    this.allowedUsers = allowedUsers;
    this.chatState = {};
    this.chatQueues = new Map();
    this.typingTimers = {};
    this._saveTimer = null;
    this._idempotencyCache = new Map();
  }

  _idempotencyKey(method, payload) {
    return method + ":" + JSON.stringify(payload);
  }

  async callApi(method, payload = {}) {
    const key = this._idempotencyKey(method, payload);
    const cached = this._idempotencyCache.get(key);
    if (cached && Date.now() - cached.ts < 5000) return cached.result;
    const res = await fetch(`${this.apiBase}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const result = await res.json();
    this._idempotencyCache.set(key, { ts: Date.now(), result });
    if (this._idempotencyCache.size > 500) {
      const keys = [...this._idempotencyCache.keys()].slice(0, 100);
      for (const k of keys) this._idempotencyCache.delete(k);
    }
    return result;
  }

  _loadChatState() {
    try { return JSON.parse(readFileSync(this.statePath, "utf-8")); } catch { return {}; }
  }

  _saveChatState() {
    try { writeFileSync(this.statePath, JSON.stringify(this.chatState)); } catch {}
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._saveChatState(); }, 500);
  }

  getState(cid) {
    if (!this.chatState[cid]) {
        const saved = this._loadChatState();
        this.chatState[cid] = saved[cid] || {
             project: "bridge",
             model: null,
             sessionId: null,
             pinnedMsgId: null,
             wizard: null,
             msgIds: [],
         };
    }
    if (!this.chatState[cid]._proxy) {
        const raw = this.chatState[cid];
        const self = this;
        this.chatState[cid] = new Proxy(raw, {
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
    return this.chatState[cid];
  }

  persistMsgId(chatId, messageId, type = "bot") {
    const st = this.getState(chatId);
    st.msgIds = [...(st.msgIds || []), { id: messageId, type }];
    this._scheduleSave();
  }

  async processChatQueue(chatId) {
    const queue = this.chatQueues.get(chatId);
    if (!queue || queue.isSending || queue.items.length === 0) return;
    queue.isSending = true;

    while (queue.items.length > 0) {
        const batch = queue.items.splice(0, queue.items.length);
        const combinedText = batch.map(i => i.text).join("\\n\\n");
        const opt = batch[batch.length - 1].opt;
        const st = this.chatState[chatId];
        
        try {
            const MAX = 4000;
            const chunks = [];
            let t = combinedText;
            while (t.length > MAX) {
                let cut = t.lastIndexOf("\\n", MAX);
                if (cut < MAX / 2) cut = MAX;
                chunks.push(t.slice(0, cut));
                t = t.slice(cut).trim();
            }
            if (t) chunks.push(t);
            
            for (let i = 0; i < chunks.length; i++) {
                const res = await this.callApi("sendMessage", {
                    chat_id: chatId,
                    text: chunks[i],
                    parse_mode: opt.md !== false ? "Markdown" : undefined,
                    disable_web_page_preview: true,
                });
                if (res.ok && res.result?.message_id && st) {
                    this.persistMsgId(chatId, res.result.message_id);
                }
                if (i < chunks.length - 1 || queue.items.length > 0) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
            batch.forEach(i => i.resolve());
        } catch (e) {
            batch.forEach(i => i.reject(e));
        }
        
        if (queue.items.length > 0) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    queue.isSending = false;
  }

  async send(chatId, text, opt = {}) {
    if (!text) text = "✅";
    return new Promise((resolve, reject) => {
        if (!this.chatQueues.has(chatId)) {
            this.chatQueues.set(chatId, { items: [], isSending: false });
        }
        const queue = this.chatQueues.get(chatId);
        queue.items.push({ text, opt, resolve, reject });
        if (!queue.isSending) {
            setTimeout(() => this.processChatQueue(chatId), 100);
        }
    });
  }

  async sendAction(chatId, action = "typing") {
    try {
        await this.callApi("sendChatAction", { chat_id: chatId, action });
    } catch (_) {}
  }

  startTyping(chatId) {
    this.stopTyping(chatId);
    this.sendAction(chatId, "typing").catch(() => {});
    this.typingTimers[chatId] = setInterval(() => {
        this.sendAction(chatId, "typing").catch(() => {});
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

  inlineKeyboard(rows) {
    return JSON.stringify({ inline_keyboard: rows });
  }
}
