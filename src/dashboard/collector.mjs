import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from '../config/index.mjs';
import { getQuotaManager } from '../core/quota-manager.mjs';
import { MetricsDB } from './metrics-db.mjs';
import { ModelHealthTracker } from './model-health.mjs';

const _quota = getQuotaManager();
const __dirname = dirname(fileURLToPath(import.meta.url));
const HYDRA_DIR = join(__dirname, '..', '..', '.hydra');
const TZ_OFFSET = config.dashboard.timezoneOffset || '+0 hours';

function formatDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'None';
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

export class MetricsCollector {
  constructor() {
    this.db = new MetricsDB();
    this.healthTracker = new ModelHealthTracker(this.db);
  }

  // Used by the dashboard API to run raw queries
  query(sql, params = []) {
    return this.db.query(sql, params);
  }

  get(sql, params = []) {
    return this.db.get(sql, params);
  }

  // Real-time ingest for Litellm calls
  logCall(data) {
    if (data.type !== 'model.completed') return;

    const ts = data.ts || new Date().toISOString().replace('T', ' ').substring(0, 19);
    const provider = data.provider || '';
    const model = data.modelId || '';
    if (!provider || !model) return;
    const fullModel = `${provider}/${model}`;

    const usage = data.data?.promptCache?.lastCallUsage || {};
    const inp = parseInt(usage.input || 0, 10);
    const out = parseInt(usage.output || 0, 10);
    let tt = parseInt(usage.totalTokens || 0, 10);
    if (tt === 0 && (inp > 0 || out > 0)) tt = inp + out;
    const cost = typeof usage.cost?.total === 'number' ? usage.cost.total : 0.0;

    let status = 'ok';
    const err = data.data?.promptError || data.data?.terminalError;
    if (err) status = 'error';
    if (data.data?.timedOut) status = 'timeout';
    if (err && String(err).toLowerCase().includes('overflow')) status = 'overflow';

    const prompt = data.prompt || '';
    const response = data.response || '';

    const insertCall = this.db.prepare(`
      INSERT OR IGNORE INTO model_calls 
      (ts, provider, model, input_tokens, output_tokens, total_tokens, cost, status, session_id, prompt, response) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertCall.run(
      ts,
      provider,
      fullModel,
      inp,
      out,
      tt,
      cost,
      status,
      data.sessionId || '',
      prompt,
      response,
    );

    // Update model health status based on real-time call results
    try {
      const nowStr = formatDateTime(new Date());
      let errMsg = 'No errors';
      if (status !== 'ok') {
        errMsg = 'Unknown error';
        if (data.data?.promptError) errMsg = String(data.data.promptError);
        else if (data.data?.terminalError) errMsg = String(data.data.terminalError);
        else if (status === 'timeout') errMsg = 'TimeoutError: 408';
        else if (status === 'overflow') errMsg = 'ContextOverflowError: context window overflow';
      }
      this.healthTracker.recordCallResult(fullModel, provider, status, errMsg, nowStr);
    } catch (e) {
      console.warn('[collector] failed to update model health from call:', e.message);
    }

    const date = ts.substring(0, 10);
    const hasError = status !== 'ok' ? 1 : 0;
    this.db
      .prepare(
        `
      INSERT INTO daily_agg (date, provider, model, calls, input_tokens, output_tokens, total_tokens, cost, errors)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(date, provider, model) DO UPDATE SET
        calls = daily_agg.calls + 1,
        input_tokens = daily_agg.input_tokens + excluded.input_tokens,
        output_tokens = daily_agg.output_tokens + excluded.output_tokens,
        total_tokens = daily_agg.total_tokens + excluded.total_tokens,
        cost = daily_agg.cost + excluded.cost,
        errors = daily_agg.errors + excluded.errors
    `,
      )
      .run(date, provider, fullModel, inp, out, tt, cost, hasError);

    let providerKey = provider.replace(/\/.+$/, '');
    if (providerKey === 'openai' || providerKey === 'opencode') providerKey = 'opencode_zen';
    _quota.reportUsage(providerKey, { model: fullModel });
  }

  updateDailyAgg() {
    // Legacy stub - now handled incrementally via ON CONFLICT upserts inside logCall
  }

  snapshotSessions() {
    const searchPaths = [
      join(HYDRA_DIR, 'loop-state.json'),
      join(HYDRA_DIR, '..', 'loop', '.hydra', 'loop-state.json'),
    ];
    let state = null;
    for (const statePath of searchPaths) {
      try {
        if (existsSync(statePath)) {
          state = JSON.parse(readFileSync(statePath, 'utf-8'));
          break;
        }
      } catch (e) {
        // @expected-error: file might be locked or corrupt during read
      }
    }
    if (!state) return;
    try {
      const phase = state.phase || 'idle';
      if (phase !== 'idle') {
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const project = state.project || 'unknown';
        this.db
          .prepare(
            `
          INSERT INTO sessions_snapshot (ts, session_key, model, agent, channel, context_pct, total_tokens)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(ts, `${project}:${phase}`, 'opencode', phase, 'bridge', 0.0, 0);
      }
    } catch (e) {
      console.warn('[collector] snapshotSessions:', e.message);
    }
  }

  insertEvent(event) {
    this._insertEventStmt ??= this.db.prepare(`
      INSERT OR IGNORE INTO events (id, ts, type, level, source, message, data, session_id, task_id, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._insertEventStmt.run(
      event.id,
      event.ts,
      event.type,
      event.level,
      event.source,
      event.message,
      event.data ? JSON.stringify(event.data) : null,
      event.sessionId || null,
      event.taskId || null,
      event.projectId || null,
    );
  }

  queryEvents({ limit = 100, level, source, type, since } = {}) {
    let where = [];
    let params = [];
    if (level) {
      where.push('level = ?');
      params.push(level);
    }
    if (source) {
      where.push('source = ?');
      params.push(source);
    }
    if (type) {
      where.push('type = ?');
      params.push(type);
    }
    if (since) {
      where.push('ts > ?');
      params.push(since);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM events ${whereClause} ORDER BY ts DESC LIMIT ?`)
      .all(...params, Math.min(limit, 1000));
  }

  cleanupEvents() {
    this.db.prepare(`DELETE FROM events WHERE ts < datetime('now', '-90 days')`).run();
  }

  cleanupOld() {
    this.db
      .prepare(`DELETE FROM model_calls WHERE ts < datetime('now', ?, '-90 days')`)
      .run(TZ_OFFSET);
    this.db
      .prepare(`DELETE FROM sessions_snapshot WHERE ts < datetime('now', ?, '-90 days')`)
      .run(TZ_OFFSET);
    this.db
      .prepare(`DELETE FROM cooldown_events WHERE ts < datetime('now', ?, '-90 days')`)
      .run(TZ_OFFSET);
    this.cleanupEvents();
  }
}
