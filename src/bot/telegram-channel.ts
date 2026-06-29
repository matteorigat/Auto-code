import { TelegramApiClient, type ApiResponse } from './telegram-api.js';
import { getTelemetryClient } from '../dashboard/telemetry-client.js';
import config from '../config/index.js';

const telemetry = getTelemetryClient();

export interface FileChange {
  path?: string;
  file?: string;
  additions?: number;
  added?: number;
  deletions?: number;
  removed?: number;
}

export interface StatusData {
  phase: string;
  taskTitle: string;
  taskId: string | null;
  project: string;
  model: string;
  tokens: number;
  cost: number;
  files: FileChange[];
  uptimeSec: number;
  lastUpdate: number;
  lastError: string | null;
  tasksCompleted: number;
  tasksBlocked: number;
  tasksTotal: number;
}

interface HumanGateRequest {
  gateType: string;
  requestId: string;
  details: unknown;
}

interface ChannelOptions {
  botToken?: string;
  chatId?: string | number;
  allowedUsers?: number[];
  bot?: { handleIPCMessage?: (msg: Record<string, unknown>) => void };
}

type ApiResult = ApiResponse & { result?: { message_id?: number } };

export class TelegramChannel {
  readonly api: TelegramApiClient;
  readonly chatId: number | null;
  readonly allowedUsers: Set<number>;
  private bot?: ChannelOptions['bot'];

  pinnedMessageId: number | null = null;
  private status: StatusData;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdate: boolean = false;
  private updateTask: Promise<void> | null = null;
  private readonly startTime: number = Date.now();
  private readonly heartbeatInterval: number = 4000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private alive: boolean = false;

  constructor({ botToken, chatId, allowedUsers = [], bot }: ChannelOptions = {}) {
    const token = botToken || config.telegram.botToken;
    this.api = new TelegramApiClient(token);
    this.chatId = chatId ? Number(chatId) : null;
    this.allowedUsers = new Set(allowedUsers);
    this.bot = bot;
    this.status = this.makeDefaultStatus();
  }

  private makeDefaultStatus(): StatusData {
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

  isReady(): boolean {
    return !!(this.api.token && this.chatId);
  }

  private notifyBridge(action: string, messageId: number, payload: Record<string, unknown>): void {
    if (this.bot && typeof process.send === 'function') {
      try {
        process.send({ type: 'telegram', action, chatId: this.chatId, messageId, payload });
      } catch {
        // Best-effort
      }
    }
  }

  startAliveHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.alive = true;
    const beat = () => {
      if (!this.alive) return;
      this.tg('sendChatAction', { action: 'typing' }).catch(() => {});
    };
    beat();
    this.heartbeatTimer = setInterval(beat, this.heartbeatInterval);
    process.once('beforeExit', () => this.stopAliveHeartbeat());
  }

  stopAliveHeartbeat(): void {
    this.alive = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async tg(method: string, payload: Record<string, unknown> = {}): Promise<ApiResult> {
    if (!this.isReady()) return { ok: false };
    const json = (await this.api.callApi(method, {
      ...payload,
      chat_id: this.chatId,
    })) as ApiResult;
    if (json.ok && json.result?.message_id) {
      this.notifyBridge(method, json.result.message_id, payload);
    }
    return json;
  }

  send(text: string, opts: Record<string, unknown> = {}): Promise<ApiResult> {
    return this.tg('sendMessage', {
      text,
      parse_mode: opts.md !== false ? 'Markdown' : undefined,
      disable_web_page_preview: true,
      ...opts,
    });
  }

  async editMessageText(
    messageId: number,
    text: string,
    opts: Record<string, unknown> = {},
  ): Promise<ApiResult> {
    return this.tg('editMessageText', {
      message_id: messageId,
      text,
      parse_mode: opts.md !== false ? 'Markdown' : undefined,
      ...opts,
    });
  }

  async initPinned(): Promise<void> {
    if (!this.isReady()) return;
    const res = await this.tg('sendMessage', { text: this.formatStatus(), parse_mode: 'Markdown' });
    if (res.ok && res.result?.message_id) {
      this.pinnedMessageId = res.result.message_id;
      await this.tg('pinChatMessage', {
        message_id: this.pinnedMessageId,
        disable_notification: true,
      }).catch(() => {});
    }
    this.startAliveHeartbeat();
  }

  updateStatus(delta: Partial<StatusData>): void {
    Object.assign(this.status, delta);
    this.status.lastUpdate = Date.now();
    this.scheduleUpdate();
    this.startAliveHeartbeat();
    telemetry.emit('loop.status', 'orchestrator', 'Loop status update', {
      data: { ...this.status },
    });
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this.flushStatus(), 2000);
  }

  private async flushStatus(): Promise<void> {
    if (!this.isReady() || !this.pinnedMessageId) return;
    if (this.updateTask) {
      this.pendingUpdate = true;
      return;
    }
    this.pendingUpdate = false;
    this.updateTask = this.doEdit().finally(() => {
      this.updateTask = null;
      if (this.pendingUpdate) this.flushStatus();
    });
    await this.updateTask;
  }

  private async doEdit(): Promise<void> {
    const res = await this.editMessageText(this.pinnedMessageId!, this.formatStatus());
    if (!res.ok) {
      const err = (res.description as string) || '';
      if (err.includes('not found') || err.includes("message can't be edited")) {
        this.pinnedMessageId = null;
        await this.initPinned();
      }
    }
  }

  formatStatus(): string {
    const s = this.status;
    const uptimeMin = Math.floor((Date.now() - this.startTime) / 60000);
    const uptimeH = Math.floor(uptimeMin / 60);
    const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

    const filesStr =
      s.files.length > 0
        ? s.files
            .map(
              (f) =>
                `${f.path || f.file} (+${f.additions || f.added || 0} -${f.deletions || f.removed || 0})`,
            )
            .slice(0, 5)
            .join('\n  ')
        : 'no files modified';

    const phaseLabels: Record<string, string> = {
      IDLE: '\u{1F7E1} Idle — looking for tasks',
      PLAN: '\u{1F4DD} Planning — preparing next task',
      EXEC: '\u2699\uFE0F  Executing — writing code',
      QA: '\u{1F9EA} Quality Gate — verifying',
      COMMIT: '\u{1F4BE} Commit — saving to git',
      SYNC: '\u2601\uFE0F  Sync — updating Notion',
      FIX: '\u{1F527} Fixing — something went wrong, retrying',
      DISCOVER: '\u{1F50D} Discovering — looking for bugs/ideas',
      WAIT_HUMAN: '\u23F3 Waiting for you — see below 👇',
      THINKING: '\u{1F4AD} Thinking…',
      STALLED: '\u26A0\uFE0F  Stalled — inactive for too long',
      CRASHED: '\u{1F6A8} CRASHED — loop failed',
    };
    const phaseLabel = phaseLabels[s.phase] || `🤖 ${s.phase}`;

    const errLine = s.lastError
      ? `\n⚠️  Last error: \`${s.lastError.slice(0, 120).replace(/`/g, "'")}\``
      : '';

    const humanHelp =
      s.phase === 'WAIT_HUMAN' ? '\n💡 *What to do:* resolve blockers, then /loop resume' : '';

    let contextLines = '';
    if (s.phase === 'WAIT_HUMAN' && s.tasksBlocked > 0) {
      const ratio = s.tasksTotal > 0 ? Math.round((s.tasksCompleted / s.tasksTotal) * 100) : 0;
      contextLines = `\n📊 *Progress:* ${ratio}% complete — ${s.tasksTotal - s.tasksCompleted} tasks remaining`;
    }

    const tokenStr =
      s.tokens >= 1000000
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

  async requestHumanGate({ gateType, requestId, details }: HumanGateRequest): Promise<void> {
    telemetry.emit('hitl.requested', 'telegram', `Human Gate Required: ${gateType}`, {
      data: { gateType, requestId, details },
    });
    if (!this.isReady()) return;
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

  async alert(level: string, text: string): Promise<void> {
    if (!this.isReady()) return;
    const icons: Record<string, string> = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };
    const prefix = `${icons[level] || 'ℹ️'} *${level.toUpperCase()}*`;
    await this.tg('sendMessage', { text: `${prefix}\n${text}`, parse_mode: 'Markdown' });
  }

  onThinking(): void {
    this.updateStatus({ phase: 'THINKING' });
  }

  onToolCall(tool: string, _title: string): void {
    this.updateStatus({ phase: `TOOL:${tool}` });
  }

  onFilesChanged(files: FileChange[]): void {
    this.updateStatus({ files });
  }

  onCost(cost: number): void {
    this.updateStatus({ cost });
  }
}

export default TelegramChannel;
