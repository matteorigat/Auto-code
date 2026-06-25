import { TelegramApiClient } from './telegram-api.mjs';
import { getTelemetryClient } from '../dashboard/telemetry-client.mjs';
import config from '../config/index.mjs';

const telemetry = getTelemetryClient();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramChannel {
  constructor({ botToken, chatId, allowedUsers = [], bot } = {}) {
    this.token = botToken || config.telegram.botToken;
    this.api = new TelegramApiClient(this.token);
    this.chatId = chatId ? Number(chatId) : null;
    this.allowedUsers = new Set(allowedUsers);
    this.bot = bot;
    this.pinnedMessageId = null;
    this._status = {
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
    this._updateTimer = null;
    this._pendingUpdate = false;
    this._updateTask = null;
    this._startTime = Date.now();
    this._heartbeatInterval = 4000;
    this._heartbeatTimer = null;
    this._alive = false;
  }

  isReady() {
    return !!(this.token && this.chatId);
  }

  _notifyBridge(action, messageId, payload) {
    if (this.bot && typeof process.send === 'function') {
      try {
        process.send({ type: 'telegram', action, chatId: this.chatId, messageId, payload });
      } catch (e) {
        // @expected-error: pinned message unpin might fail if not exists
      }
    }
  }

  startAliveHeartbeat() {
    if (this._heartbeatTimer) return;
    this._alive = true;
    const beat = () => {
      if (!this._alive) return;
      this.tg('sendChatAction', { action: 'typing' }).catch(() => {});
    };
    beat();
    this._heartbeatTimer = setInterval(beat, this._heartbeatInterval);
    process.once('beforeExit', () => this.stopAliveHeartbeat());
  }

  stopAliveHeartbeat() {
    this._alive = false;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async tg(method, payload = {}) {
    if (!this.isReady()) return { ok: false };
    const json = await this.api.callApi(method, { ...payload, chat_id: this.chatId });
    if (json.ok && json.result?.message_id && !json.cached) {
      this._notifyBridge(method, json.result.message_id, payload);
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
    if (!this.isReady()) return;
    const text = this._formatStatus();
    const res = await this.tg('sendMessage', { text, parse_mode: 'Markdown' });
    if (res.ok && res.result?.message_id) {
      this.pinnedMessageId = res.result.message_id;
      await this.tg('pinChatMessage', {
        message_id: this.pinnedMessageId,
        disable_notification: true,
      }).catch(() => {});
    }
    this.startAliveHeartbeat();
  }

  updateStatus(delta) {
    Object.assign(this._status, delta);
    this._status.lastUpdate = Date.now();
    this._scheduleUpdate();
    this.startAliveHeartbeat();
    telemetry.emit('loop.status', 'orchestrator', 'Loop status update', {
      data: { ...this._status },
    });
  }

  _scheduleUpdate() {
    if (this._updateTimer) clearTimeout(this._updateTimer);
    this._updateTimer = setTimeout(() => this._flushStatus(), 2000);
  }

  async _flushStatus() {
    if (!this.isReady() || !this.pinnedMessageId) return;
    if (this._updateTask) {
      this._pendingUpdate = true;
      return;
    }
    this._pendingUpdate = false;
    this._updateTask = this._doEdit().finally(() => {
      this._updateTask = null;
      if (this._pendingUpdate) this._flushStatus();
    });
    await this._updateTask;
  }

  async _doEdit() {
    const text = this._formatStatus();
    const res = await this.editMessageText(this.pinnedMessageId, text);
    if (!res.ok) {
      const err = res.description || '';
      if (err.includes('not found') || err.includes("message can't be edited")) {
        this.pinnedMessageId = null;
        await this.initPinned();
      }
    }
  }

  _formatStatus() {
    const s = this._status;
    const uptimeMin = Math.floor((Date.now() - this._startTime) / 60000);
    const uptimeH = Math.floor(uptimeMin / 60);
    const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

    const files =
      s.files.length > 0
        ? s.files
            .map(
              (f) =>
                `${f.path || f.file} (+${f.additions || f.added || 0} -${f.deletions || f.removed || 0})`,
            )
            .slice(0, 5)
            .join('\n  ')
        : 'no files modified';

    const phaseLabels = {
      IDLE: '\u{1F7E1} Idle \u2014 looking for tasks',
      PLAN: '\u{1F4DD} Planning \u2014 preparing next task',
      EXEC: '\u2699\uFE0F  Executing \u2014 writing code',
      QA: '\u{1F9EA} Quality Gate \u2014 verifying',
      COMMIT: '\u{1F4BE} Commit \u2014 saving to git',
      SYNC: '\u2601\uFE0F  Sync \u2014 updating Notion',
      FIX: '\u{1F527} Fixing \u2014 something went wrong, retrying',
      DISCOVER: '\u{1F50D} Discovering \u2014 looking for bugs/ideas',
      WAIT_HUMAN: '\u23F3 Waiting for you \u2014 see below \u{1F447}',
      THINKING: '\u{1F4AD} Thinking\u2026',
      STALLED: '\u26A0\uFE0F  Stalled \u2014 inactive for too long',
      CRASHED: '\u{1F6A8} CRASHED \u2014 loop failed',
    };
    const phaseLabel = phaseLabels[s.phase] || `\u{1F916} ${s.phase}`;

    const errLine = s.lastError
      ? `\n\u26A0\uFE0F  Last error: \`${s.lastError.slice(0, 120).replace(/`/g, "'")}\``
      : '';

    const humanHelp =
      s.phase === 'WAIT_HUMAN'
        ? '\n\u{1F4A1} *What to do:* resolve blockers, then /loop resume'
        : '';

    let contextLines = '';
    if (s.phase === 'WAIT_HUMAN' && s.tasksBlocked > 0) {
      const ratio = s.tasksTotal > 0 ? Math.round((s.tasksCompleted / s.tasksTotal) * 100) : 0;
      contextLines = `\n\u{1F4CA} *Progress:* ${ratio}% complete \u2014 ${s.tasksTotal - s.tasksCompleted} tasks remaining`;
    }

    const tokenStr =
      s.tokens >= 1000000
        ? (s.tokens / 1000000).toFixed(2) + 'M'
        : s.tokens >= 1000
          ? (s.tokens / 1000).toFixed(1) + 'k'
          : s.tokens;

    return [
      `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
      `  \u{1F40D} *HYDRA LOOP*  \u00B7  \`${s.project}\``,
      `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
      ``,
      `${phaseLabel}${errLine}`,
      ``,
      `\u{1F4CA} *Tasks:*   \u2705 ${s.tasksCompleted}  |  \u26D4 ${s.tasksBlocked}  |  \u{1F4CB} ${s.tasksTotal} total`,
      `${contextLines}`,
      `\u{1F9E0} *Task:* ${s.taskTitle.slice(0, 80) || 'none'}`,
      `\u{1F4B0} *Cost:* $${s.cost.toFixed(2)}  |  \u{1F4C8} *Tokens:* ${tokenStr}  |  \u23F1\uFE0F *Uptime:* ${uptimeStr}`,
      `${humanHelp}`,
      `\u{1F4DD} *Files:* ${files}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async requestHumanGate({ gateType, requestId, details }) {
    telemetry.emit('hitl.requested', 'telegram', `Human Gate Required: ${gateType}`, {
      data: { gateType, requestId, details },
    });
    if (!this.isReady()) return;
    const kb = {
      inline_keyboard: [
        [
          { text: '\u2705 Approve', callback_data: `hydra:approve:${gateType}:${requestId}` },
          { text: '\u274C Reject', callback_data: `hydra:reject:${gateType}:${requestId}` },
        ],
        [
          { text: '\u23F8 Pause Loop', callback_data: `hydra:pause` },
          { text: '\u25B6\uFE0F Resume Loop', callback_data: `hydra:resume` },
          { text: '\u26D4 Abort', callback_data: `hydra:abort:${requestId}` },
        ],
      ],
    };

    const msg = `\u{1F514} *Human Gate Required*\n\nType: *${gateType}*\nReq ID: \`${requestId}\`\n\nDetails:\n\`\`\`\n${JSON.stringify(details, null, 2).slice(0, 800)}\n\`\`\``;
    await this.tg('sendMessage', {
      text: msg,
      parse_mode: 'Markdown',
      reply_markup: JSON.stringify(kb),
    });
  }

  async alert(level, text) {
    if (!this.isReady()) return;
    const icons = { info: '\u2139\uFE0F', warn: '\u26A0\uFE0F', critical: '\u{1F6A8}' };
    const prefix = `${icons[level] || '\u2139\uFE0F'} *${level.toUpperCase()}*`;
    const full = `${prefix}\n${text}`;
    await this.tg('sendMessage', { text: full, parse_mode: 'Markdown' });
  }

  onThinking() {
    this.updateStatus({ phase: 'THINKING' });
  }

  onToolCall(tool, title) {
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
