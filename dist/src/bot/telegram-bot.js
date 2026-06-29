import { readFileSync, writeFileSync } from 'node:fs';
import { TelegramApiClient } from './telegram-api.js';
const CHUNK_MAX = 3500;
const RATE_LIMIT_WAIT = 1000;
export class BridgeBot {
    token;
    api;
    statePath;
    allowedUsers;
    chatState = {};
    chatQueues = new Map();
    typingTimers = {};
    saveTimer = null;
    constructor(token, statePath, allowedUsers) {
        this.token = token;
        this.api = new TelegramApiClient(token);
        this.statePath = statePath;
        this.allowedUsers = allowedUsers;
    }
    async callApi(method, payload = {}) {
        return this.api.callApi(method, payload);
    }
    loadChatState() {
        try {
            return JSON.parse(readFileSync(this.statePath, 'utf-8'));
        }
        catch {
            return {};
        }
    }
    saveChatState() {
        try {
            writeFileSync(this.statePath, JSON.stringify(this.chatState));
        }
        catch {
            console.error('[BridgeBot] Failed to save state');
        }
    }
    scheduleSave() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.saveChatState();
        }, 500);
    }
    getState(cid) {
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
    persistMsgId(chatId, messageId, type = 'bot') {
        const st = this.getState(chatId);
        if (!st.msgIds.some((m) => m.id === messageId)) {
            st.msgIds = [...st.msgIds, { id: messageId, type }];
        }
        if (type === 'bot')
            st.lastBotMsgId = messageId;
        this.scheduleSave();
    }
    deleteMsgIds(chatId, ids) {
        const st = this.getState(chatId);
        st.msgIds = st.msgIds.filter((m) => !ids.includes(m.id));
    }
    splitMarkdownSafe(text) {
        if (text.length <= CHUNK_MAX)
            return [text];
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
                if (cut < CHUNK_MAX / 2)
                    cut = CHUNK_MAX;
            }
            chunks.push(remaining.slice(0, cut).trim());
            remaining = remaining.slice(cut).trim();
        }
        return chunks;
    }
    async processChatQueue(chatId) {
        const queue = this.chatQueues.get(String(chatId));
        if (!queue || queue.isSending || queue.items.length === 0)
            return;
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
                const result = res.result;
                if (res.ok && result?.message_id && st) {
                    this.persistMsgId(chatId, result.message_id);
                }
                if (i < chunks.length - 1)
                    await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT));
            }
            batch.forEach((i) => i.resolve(undefined));
        }
        catch (e) {
            const err = e;
            if (err.description?.includes('429')) {
                const retryAfter = err.parameters?.retry_after ?? 5;
                queue.items.unshift(...batch);
                await new Promise((r) => setTimeout(r, retryAfter * 1000));
            }
            else {
                batch.forEach((i) => i.reject(e));
            }
        }
        queue.isSending = false;
        if (queue.items.length > 0) {
            setTimeout(() => this.processChatQueue(chatId), RATE_LIMIT_WAIT);
        }
    }
    async send(chatId, text, opt = {}) {
        if (!text)
            return;
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
                if (desc.includes('message is not modified'))
                    return;
                if (desc.includes('not found') || desc.includes("message can't be edited")) {
                    await this.send(chatId, text, opt);
                    return;
                }
            }
            return res;
        }
        catch {
            console.error('[BridgeBot] editMessageText error');
            return undefined;
        }
    }
    async deleteMessage(chatId, messageId) {
        try {
            await this.callApi('deleteMessage', { chat_id: chatId, message_id: messageId });
        }
        catch {
            // Best-effort: message may already be deleted
        }
    }
    async sendOrUpdate(chatId, text, opt = {}) {
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
    async deleteAllBotMessages(chatId) {
        const st = this.getState(chatId);
        const botIds = st.msgIds.filter((m) => m.type === 'bot');
        for (const m of botIds) {
            await this.deleteMessage(chatId, m.id);
            await new Promise((r) => setTimeout(r, 50));
        }
        this.deleteMsgIds(chatId, botIds.map((m) => m.id));
        st.lastBotMsgId = null;
    }
    async sendAction(chatId, action = 'typing') {
        try {
            await this.callApi('sendChatAction', { chat_id: chatId, action });
        }
        catch {
            // Best-effort
        }
    }
    startTyping(chatId) {
        this.stopTyping(chatId);
        this.sendAction(chatId).catch(() => { });
        this.typingTimers[String(chatId)] = setInterval(() => {
            this.sendAction(chatId).catch(() => { });
        }, 4000);
    }
    stopTyping(chatId) {
        const timer = this.typingTimers[String(chatId)];
        if (timer) {
            clearInterval(timer);
            delete this.typingTimers[String(chatId)];
        }
    }
    stopAllTyping() {
        for (const cid of Object.keys(this.typingTimers)) {
            this.stopTyping(Number(cid));
        }
    }
    persist() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.saveChatState();
    }
    inlineKeyboard(rows) {
        return JSON.stringify({ inline_keyboard: rows });
    }
    handleIPCMessage(msg) {
        const action = msg.action;
        if (msg.type !== 'telegram' || !action)
            return;
        const payload = msg.payload ?? {};
        const methodMap = {
            sendMessage: 'send',
            editMessageText: 'updateMessage',
            deleteMessage: 'deleteMessage',
            sendChatAction: 'sendAction',
            sendOrUpdate: 'sendOrUpdate',
        };
        const methodName = methodMap[action];
        if (!methodName) {
            this.callApi(action, { chat_id: msg.chatId, ...payload }).catch(() => { });
            return;
        }
        const { chatId, ...rest } = payload;
        const cid = (chatId ?? msg.chatId);
        if (!cid)
            return;
        switch (methodName) {
            case 'send':
            case 'sendOrUpdate':
                this.send(cid, rest.text ?? '', rest);
                break;
            case 'updateMessage':
            case 'deleteMessage':
                this[methodName](cid, rest.messageId, rest.text ?? '', rest);
                break;
            case 'sendAction':
                this.sendAction(cid, rest.action ?? 'typing');
                break;
            default:
                this[methodName](cid, rest);
        }
    }
}
