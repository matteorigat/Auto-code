#!/usr/bin/env node
/**
 * Telegram Channel — Real-time status dashboard + Human-in-the-Loop
 *
 * Features from opencode-telegram-bot:
 *   - Pinned status message (debounced updates)
 *   - Inline keyboards for HITL gates
 *   - Streaming notifications (thinking, tool calls, file changes)
 *   - Alert escalation levels (info / warn / critical)
 *   - CONTINUOUS TYPING HEARTBEAT: if typing stops > 2 minutes, user assumes crash.
 */

import crypto from "node:crypto";

const TG_API = (token) => `https://api.telegram.org/bot${token}`;

export class TelegramChannel {
  constructor({ botToken, chatId, allowedUsers = [], onMessageSent } = {}) {
    this.token = botToken || process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = chatId ? Number(chatId) : null;
    this.allowedUsers = new Set(allowedUsers);
    this._onMessageSent = onMessageSent; // callback(msgId, chatId) for /new cleanup
    this.pinnedMessageId = null;
    this._status = {
      phase: "IDLE",
      taskTitle: "—",
      taskId: null,
      project: "—",
      model: "—",
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

    // 🫀 Alive heartbeat: keep "typing" action alive while loop is running.
    // If this stops, the user sees nothing and assumes crash.
    this._heartbeatInterval = 4000; // ms (must be < chat action expiry ~5s)
    this._heartbeatTimer = null;
    this._alive = false;
    this._idempotencyCache = new Map();
  }

  isReady() { return !!(this.token && this.chatId); }

  /* ─── Alive Heartbeat ─── */
  startAliveHeartbeat() {
    if (this._heartbeatTimer) return;
    this._alive = true;
    const beat = () => {
      if (!this._alive) return;
      this.tg("sendChatAction", { action: "typing" }).catch(() => {});
    };
    beat();
    this._heartbeatTimer = setInterval(beat, this._heartbeatInterval);
  }

  stopAliveHeartbeat() {
    this._alive = false;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /* ─── Telegram HTTP ─── */
  async tg(method, payload = {}) {
    if (!this.isReady()) return { ok: false };
    const hashStr = method + JSON.stringify(payload);
    const hash = crypto.createHash("md5").update(hashStr).digest("hex");
    const now = Date.now();
    if (this._idempotencyCache.has(hash) && (now - this._idempotencyCache.get(hash)) < 3000) {
      return { ok: true, cached: true };
    }
    this._idempotencyCache.set(hash, now);
    for (const [k, v] of this._idempotencyCache.entries()) {
      if (now - v > 10000) this._idempotencyCache.delete(k);
    }

    const url = `${TG_API(this.token)}/${method}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, chat_id: this.chatId }),
      });
      const json = await res.json();
      if (json.ok && json.result?.message_id && this._onMessageSent) {
        this._onMessageSent(json.result.message_id, this.chatId);
      }
      return json;
    } catch {
      return { ok: false };
    }
  }

  send(text, opts = {}) {
    return this.tg("sendMessage", { text, parse_mode: opts.md !== false ? "Markdown" : undefined, disable_web_page_preview: true, ...opts });
  }

  /* ─── Pinned status ─── */
  async initPinned() {
    if (!this.isReady()) return;
    const text = this._formatStatus();
    const res = await this.tg("sendMessage", { text, parse_mode: "Markdown" });
    if (res.ok && res.result?.message_id) {
      this.pinnedMessageId = res.result.message_id;
      await this.tg("pinChatMessage", { message_id: this.pinnedMessageId, disable_notification: true }).catch(() => {});
    }
    this.startAliveHeartbeat();
  }

  updateStatus(delta) {
    Object.assign(this._status, delta);
    this._status.lastUpdate = Date.now();
    this._scheduleUpdate();
    // Ensure heartbeat is running whenever loop is active
    this.startAliveHeartbeat();
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
    const res = await this.tg("editMessageText", { message_id: this.pinnedMessageId, text, parse_mode: "Markdown" });
    if (!res.ok) {
      const err = res.description || "";
      if (err.includes("not found") || err.includes("_badmsg")) {
        this.pinnedMessageId = null;
        await this.initPinned();
      } else if (err.includes("message is not modified")) {
        // Nothing changed — skip
      }
    }
  }

  _formatStatus() {
    const s = this._status;
    const uptimeMin = Math.floor((Date.now() - this._startTime) / 60000);
    const uptimeH = Math.floor(uptimeMin / 60);
    const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

    const files = s.files.length > 0
      ? s.files.map((f) => `${f.path || f.file} (+${f.additions || f.added || 0} -${f.deletions || f.removed || 0})`).slice(0, 5).join("\n  ")
      : "nessun file modificato";

    // Phase names in italiano + spiegazione
    const phaseLabels = {
      "IDLE":       "🟡 In attesa — cerco nuovi task",
      "PLAN":       "📝 Pianificazione — preparo il prossimo task",
      "EXEC":       "⚙️  Esecuzione — sto scrivendo codice",
      "QA":         "🧪 Quality Gate — verifico che funzioni",
      "COMMIT":     "💾 Commit — salvo le modifiche su git",
      "SYNC":       "☁️  Sync — aggiorno Notion",
      "FIX":        "🔧 Riparazione — qualcosa è andato storto, riprovo",
      "DISCOVER":   "🔍 Scoperta — cerco bug e nuove idee",
      "WAIT_HUMAN": "⏳ In attesa di te — guarda sotto 👇",
      "THINKING":   "💭 Sto pensando…",
      "STALLED":    "⚠️  Bloccato — nessuna attività da troppo tempo",
      "CRASHED":    "🚨 CRASH — il loop è caduto",
    };
    const phaseLabel = phaseLabels[s.phase] || `🤖 ${s.phase}`;

    // Error line (truncated)
    const errLine = s.lastError
      ? `\n⚠️  Ultimo errore: \`${s.lastError.slice(0, 120).replace(/`/g, "'")}\``
      : "";

    // WAIT_HUMAN suggestion
    const humanHelp = s.phase === "WAIT_HUMAN"
      ? "\n💡 *Cosa fare:* risolvi i blocchi su Notion, poi /loop resume"
      : "";

    // Linee contestuali in base alla fase
    let contextLines = "";
    if (s.phase === "WAIT_HUMAN" && s.tasksBlocked > 0) {
      const ratio = s.tasksTotal > 0 ? Math.round((s.tasksCompleted / s.tasksTotal) * 100) : 0;
      contextLines = `\n📊 *Avanzamento:* ${ratio}% completo — ${s.tasksTotal - s.tasksCompleted} task ancora da fare`;
    }

    const tokenStr = s.tokens >= 1000000 
      ? (s.tokens / 1000000).toFixed(2) + "M" 
      : (s.tokens >= 1000 ? (s.tokens / 1000).toFixed(1) + "k" : s.tokens);

    return [
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `  🐍 *HYDRA LOOP*  ·  \`${s.project}\``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `${phaseLabel}${errLine}`,
      ``,
      `📊 *Task completati:*   ✅ ${s.tasksCompleted}  |  ⛔ ${s.tasksBlocked}  |  📋 ${s.tasksTotal} totali`,
      `${contextLines}`,
      `🧠 *Task in corso:* ${s.taskTitle.slice(0, 80) || "nessuno"}`,
      `💰 *Costo:* $${s.cost.toFixed(2)}  |  📈 *Token:* ${tokenStr}  |  ⏱️ *Attivo da:* ${uptimeStr}`,
      `${humanHelp}`,
      `📝 *File modificati:* ${files}`,
    ].filter(Boolean).join("\n");
  }

  /* ─── Interactive HITL ─── */
  async requestHumanGate({ gateType, requestId, details }) {
    if (!this.isReady()) return;
    const kb = {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `hydra:approve:${gateType}:${requestId}` },
          { text: "❌ Reject", callback_data: `hydra:reject:${gateType}:${requestId}` },
        ],
        [
          { text: "⏸ Pause Loop", callback_data: `hydra:pause` },
          { text: "▶️ Resume Loop", callback_data: `hydra:resume` },
          { text: "⛔ Abort", callback_data: `hydra:abort:${requestId}` },
        ],
      ],
    };

    const msg = `🔔 *Human Gate Required*\n\nType: *${gateType}*\nReq ID: \`${requestId}\`\n\nDetails:\n\`\`\`\n${JSON.stringify(details, null, 2).slice(0, 800)}\n\`\`\``;
    await this.tg("sendMessage", { text: msg, parse_mode: "Markdown", reply_markup: JSON.stringify(kb) });
  }

  /* ─── Alerts ─── */
  async alert(level, text) {
    if (!this.isReady()) return;
    const icons = { info: "ℹ️", warn: "⚠️", critical: "🚨" };
    const prefix = `${icons[level] || "ℹ️"} *${level.toUpperCase()}*`;
    const full = `${prefix}\n${text}`;
    await this.tg("sendMessage", { text: full, parse_mode: "Markdown" });
  }

  /* ─── Streaming events ─── */
  onThinking() {
    this.updateStatus({ phase: "THINKING" });
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
