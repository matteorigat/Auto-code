import { TelegramApiClient } from './telegram-api.js';
import { getTelemetryClient } from '../dashboard/telemetry-client.js';
import config from '../config/index.js';
const telemetry = getTelemetryClient();
export class TelegramChannel {
    api;
    chatId;
    allowedUsers;
    bot;
    pinnedMessageId = null;
    status;
    updateTimer = null;
    pendingUpdate = false;
    updateTask = null;
    startTime = Date.now();
    heartbeatInterval = 4000;
    heartbeatTimer = null;
    alive = false;
    constructor({ botToken, chatId, allowedUsers = [], bot } = {}) {
        const token = botToken || config.telegram.botToken;
        this.api = new TelegramApiClient(token);
        this.chatId = chatId ? Number(chatId) : null;
        this.allowedUsers = new Set(allowedUsers);
        this.bot = bot;
        this.status = this.makeDefaultStatus();
    }
    makeDefaultStatus() {
        return {
            phase: 'IDLE',
            taskTitle: '—',
            taskId: null,
            project: '—',
            model: '—',
            tokens: 0,
            cost: 0,
            files: [],
            uptimeSec: 0,
            lastUpdate: 0,
            lastError: null,
            tasksCompleted: 0,
            tasksBlocked: 0,
            tasksTotal: 0,
        };
    }
    isReady() {
        return !!(this.api.token && this.chatId);
    }
    notifyBridge(action, messageId, payload) {
        if (this.bot && typeof process.send === 'function') {
            try {
                process.send({ type: 'telegram', action, chatId: this.chatId, messageId, payload });
            }
            catch {
                // Best-effort
            }
        }
    }
    startAliveHeartbeat() {
        if (this.heartbeatTimer)
            return;
        this.alive = true;
        const beat = () => {
            if (!this.alive)
                return;
            this.tg('sendChatAction', { action: 'typing' }).catch(() => { });
        };
        beat();
        this.heartbeatTimer = setInterval(beat, this.heartbeatInterval);
        process.once('beforeExit', () => this.stopAliveHeartbeat());
    }
    stopAliveHeartbeat() {
        this.alive = false;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    async tg(method, payload = {}) {
        if (!this.isReady())
            return { ok: false };
        const json = (await this.api.callApi(method, {
            ...payload,
            chat_id: this.chatId,
        }));
        if (json.ok && json.result?.message_id) {
            this.notifyBridge(method, json.result.message_id, payload);
        }
        return json;
    }
    send(text, opts = {}) {
        return this.tg('sendMessage', {
            text,
            parse_mode: opts.md !== false ? 'Markdown' : undefined,
            disable_web_page_preview: true,
            ...opts,
        });
    }
    async editMessageText(messageId, text, opts = {}) {
        return this.tg('editMessageText', {
            message_id: messageId,
            text,
            parse_mode: opts.md !== false ? 'Markdown' : undefined,
            ...opts,
        });
    }
    async initPinned() {
        if (!this.isReady())
            return;
        const res = await this.tg('sendMessage', { text: this.formatStatus(), parse_mode: 'Markdown' });
        if (res.ok && res.result?.message_id) {
            this.pinnedMessageId = res.result.message_id;
            await this.tg('pinChatMessage', {
                message_id: this.pinnedMessageId,
                disable_notification: true,
            }).catch(() => { });
        }
        this.startAliveHeartbeat();
    }
    updateStatus(delta) {
        Object.assign(this.status, delta);
        this.status.lastUpdate = Date.now();
        this.scheduleUpdate();
        this.startAliveHeartbeat();
        telemetry.emit('loop.status', 'orchestrator', 'Loop status update', {
            data: { ...this.status },
        });
    }
    getStatus() {
        return this.status;
    }
    scheduleUpdate() {
        if (this.updateTimer)
            clearTimeout(this.updateTimer);
        this.updateTimer = setTimeout(() => this.flushStatus(), 2000);
    }
    async flushStatus() {
        if (!this.isReady() || !this.pinnedMessageId)
            return;
        if (this.updateTask) {
            this.pendingUpdate = true;
            return;
        }
        this.pendingUpdate = false;
        this.updateTask = this.doEdit().finally(() => {
            this.updateTask = null;
            if (this.pendingUpdate)
                this.flushStatus();
        });
        await this.updateTask;
    }
    async doEdit() {
        const res = await this.editMessageText(this.pinnedMessageId, this.formatStatus());
        if (!res.ok) {
            const err = res.description || '';
            if (err.includes('not found') || err.includes("message can't be edited")) {
                this.pinnedMessageId = null;
                await this.initPinned();
            }
        }
    }
    formatStatus() {
        const s = this.status;
        const uptimeMin = Math.floor((Date.now() - this.startTime) / 60000);
        const uptimeH = Math.floor(uptimeMin / 60);
        const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;
        const filesStr = s.files.length > 0
            ? s.files
                .map((f) => `${f.path || f.file} (+${f.additions || f.added || 0} -${f.deletions || f.removed || 0})`)
                .slice(0, 5)
                .join('\n  ')
            : 'no files modified';
        const phaseLabels = {
            IDLE: '🔮 Idle — looking for tasks',
            PLAN: '📝 Planning — preparing next task',
            EXEC: '⚙️  Executing — writing code',
            CODE: '💻 Code — writing code & implementing',
            QA: '🧪 Quality Gate — verifying',
            COMMIT: '💾 Commit — saving to git',
            SYNC: '☁️  Sync — updating Notion',
            FIX: '🔧 Fixing — something went wrong, retrying',
            DISCOVER: '🔍 Discovering — looking for bugs/ideas',
            WAIT_HUMAN: '⏳ Waiting for you — see below 👇',
            THINKING: '💭 Thinking…',
            STALLED: '⚠️  Stalled — inactive for too long',
            CRASHED: '🚨 CRASHED — loop failed',
        };
        const phaseLabel = phaseLabels[s.phase] || `🤖 ${s.phase}`;
        const errLine = s.lastError
            ? `\n⚠️  Last error: \`${s.lastError.slice(0, 120).replace(/`/g, "'")}\``
            : '';
        const humanHelp = s.phase === 'WAIT_HUMAN' ? '\n💡 *What to do:* resolve blockers, then /loop resume' : '';
        let contextLines = '';
        if (s.phase === 'WAIT_HUMAN' && s.tasksBlocked > 0) {
            const ratio = s.tasksTotal > 0 ? Math.round((s.tasksCompleted / s.tasksTotal) * 100) : 0;
            contextLines = `\n📊 *Progress:* ${ratio}% complete — ${s.tasksTotal - s.tasksCompleted} tasks remaining`;
        }
        const tokenStr = s.tokens >= 1000000
            ? (s.tokens / 1000000).toFixed(2) + 'M'
            : s.tokens >= 1000
                ? (s.tokens / 1000).toFixed(1) + 'k'
                : String(s.tokens);
        return [
            `──────────────────────────────`,
            `  🐍 *HYDRA LOOP*  ·  \`${s.project}\``,
            `──────────────────────────────`,
            ``,
            `${phaseLabel}${errLine}`,
            ``,
            `📊 *Tasks:*   ✅ ${s.tasksCompleted}  |  ⛔ ${s.tasksBlocked}  |  📋 ${s.tasksTotal} total`,
            `${contextLines}`,
            `🧠 *Task:* ${s.taskTitle.slice(0, 80) || 'none'}`,
            `💰 *Cost:* $${s.cost.toFixed(2)}  |  📈 *Tokens:* ${tokenStr}  |  ⏱️ *Uptime:* ${uptimeStr}`,
            `${humanHelp}`,
            `📝 *Files:* ${filesStr}`,
        ]
            .filter(Boolean)
            .join('\n');
    }
    async requestHumanGate({ gateType, requestId, details }) {
        telemetry.emit('hitl.requested', 'telegram', `Human Gate Required: ${gateType}`, {
            data: { gateType, requestId, details },
        });
        if (!this.isReady())
            return;
        const kb = {
            inline_keyboard: [
                [
                    { text: '✅ Approve', callback_data: `hydra:approve:${gateType}:${requestId}` },
                    { text: '❌ Reject', callback_data: `hydra:reject:${gateType}:${requestId}` },
                ],
                [
                    { text: '⏸ Pause Loop', callback_data: 'hydra:pause' },
                    { text: '▶️ Resume Loop', callback_data: 'hydra:resume' },
                    { text: '⛔ Abort', callback_data: `hydra:abort:${requestId}` },
                ],
            ],
        };
        const msg = `🔔 *Human Gate Required*\n\nType: *${gateType}*\nReq ID: \`${requestId}\`\n\nDetails:\n\`\`\`\n${JSON.stringify(details, null, 2).slice(0, 800)}\n\`\`\``;
        await this.tg('sendMessage', {
            text: msg,
            parse_mode: 'Markdown',
            reply_markup: JSON.stringify(kb),
        });
    }
    async alert(level, text) {
        if (!this.isReady())
            return;
        const icons = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };
        const prefix = `${icons[level] || 'ℹ️'} *${level.toUpperCase()}*`;
        await this.tg('sendMessage', { text: `${prefix}\n${text}`, parse_mode: 'Markdown' });
    }
    onThinking() {
        this.updateStatus({ phase: 'THINKING' });
    }
    onToolCall(tool, _title) {
        this.updateStatus({ phase: `TOOL:${tool}` });
    }
    onFilesChanged(files) {
        this.updateStatus({ files });
    }
    onCost(cost) {
        this.updateStatus({ cost });
    }
}
export default TelegramChannel;
