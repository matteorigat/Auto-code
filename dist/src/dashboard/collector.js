import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from '../config/index.js';
import { getQuotaManager } from '../core/quota-manager.js';
import { MetricsDB } from './metrics-db.js';
import { ModelHealthTracker } from './model-health.js';
const _quota = getQuotaManager();
const __dirname = dirname(fileURLToPath(import.meta.url));
const HYDRA_DIR = join(__dirname, '..', '..', '.hydra');
function getDashboardConfig() {
    return config.dashboard || {};
}
function formatDateTime(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(date);
    if (isNaN(d.getTime()))
        return 'None';
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const year = d.getFullYear();
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}
export class MetricsCollector {
    db;
    healthTracker;
    constructor() {
        this.db = new MetricsDB();
        this.healthTracker = new ModelHealthTracker(this.db);
    }
    query(sql, params = []) {
        return this.db.query(sql, params);
    }
    get(sql, params = []) {
        return this.db.get(sql, params);
    }
    logCall(data) {
        if (!data || data.type !== 'model.completed')
            return;
        const ts = data.ts || new Date().toISOString().replace('T', ' ').substring(0, 19);
        const provider = data.provider || '';
        const model = data.modelId || '';
        if (!provider || !model)
            return;
        const fullModel = `${provider}/${model}`;
        const innerData = (data.data || {});
        const promptCache = innerData.promptCache || {};
        const usage = promptCache.lastCallUsage || {};
        const inp = parseInt(String(usage.input ?? '0'), 10);
        const out = parseInt(String(usage.output ?? '0'), 10);
        let tt = parseInt(String(usage.totalTokens ?? '0'), 10);
        if (tt === 0 && (inp > 0 || out > 0))
            tt = inp + out;
        const usageCost = usage.cost;
        const cost = typeof usageCost?.total === 'number' ? usageCost.total : 0.0;
        let status = 'ok';
        const err = innerData.promptError || innerData.terminalError;
        if (err)
            status = 'error';
        if (innerData.timedOut)
            status = 'timeout';
        if (err && String(err).toLowerCase().includes('overflow'))
            status = 'overflow';
        const prompt = data.prompt || '';
        const response = data.response || '';
        const insertCall = this.db.prepare(`
      INSERT OR IGNORE INTO model_calls 
      (ts, provider, model, input_tokens, output_tokens, total_tokens, cost, status, session_id, prompt, response) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        insertCall.run(ts, provider, fullModel, inp, out, tt, cost, status, data.sessionId || '', prompt, response);
        try {
            const nowStr = formatDateTime(new Date());
            let errMsg = 'No errors';
            if (status !== 'ok') {
                errMsg = 'Unknown error';
                if (innerData.promptError)
                    errMsg = String(innerData.promptError);
                else if (innerData.terminalError)
                    errMsg = String(innerData.terminalError);
                else if (status === 'timeout')
                    errMsg = 'TimeoutError: 408';
                else if (status === 'overflow')
                    errMsg = 'ContextOverflowError: context window overflow';
            }
            this.healthTracker.recordCallResult(fullModel, provider, status, errMsg, nowStr);
        }
        catch (e) {
            console.warn('[collector] failed to update model health from call:', e instanceof Error ? e.message : String(e));
        }
        const date = ts.substring(0, 10);
        const hasError = status !== 'ok' ? 1 : 0;
        this.db
            .prepare(`
      INSERT INTO daily_agg (date, provider, model, calls, input_tokens, output_tokens, total_tokens, cost, errors)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(date, provider, model) DO UPDATE SET
        calls = daily_agg.calls + 1,
        input_tokens = daily_agg.input_tokens + excluded.input_tokens,
        output_tokens = daily_agg.output_tokens + excluded.output_tokens,
        total_tokens = daily_agg.total_tokens + excluded.total_tokens,
        cost = daily_agg.cost + excluded.cost,
        errors = daily_agg.errors + excluded.errors
    `)
            .run(date, provider, fullModel, inp, out, tt, cost, hasError);
        let providerKey = provider.replace(/\/.+$/, '');
        if (providerKey === 'openai' || providerKey === 'opencode')
            providerKey = 'opencode_zen';
        _quota.reportUsage(providerKey, { model: fullModel });
    }
    updateDailyAgg() { }
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
            }
            catch {
                // Ignore JSON parsing errors
            }
        }
        if (!state)
            return;
        try {
            const phase = state.phase || 'idle';
            if (phase !== 'idle') {
                const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
                const project = state.project || 'unknown';
                this.db
                    .prepare(`
          INSERT INTO sessions_snapshot (ts, session_key, model, agent, channel, context_pct, total_tokens)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
                    .run(ts, `${project}:${phase}`, 'opencode', phase, 'bridge', 0.0, 0);
            }
        }
        catch (e) {
            console.warn('[collector] snapshotSessions:', e instanceof Error ? e.message : String(e));
        }
    }
    insertEvent(event) {
        const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (id, ts, type, level, source, message, data, session_id, task_id, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(event.id, event.ts, event.type, event.level, event.source, event.message, event.data ? JSON.stringify(event.data) : null, event.sessionId || null, event.taskId || null, event.projectId || null);
    }
    queryEvents({ limit = 100, level, source, type, since, } = {}) {
        const where = [];
        const params = [];
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
        const results = this.db
            .prepare(`SELECT * FROM events ${whereClause} ORDER BY ts DESC LIMIT ?`)
            .all(...params, Math.min(limit, 1000));
        return results;
    }
    cleanupEvents() {
        this.db.prepare(`DELETE FROM events WHERE ts < datetime('now', '-90 days')`).run();
    }
    cleanupOld() {
        const tzOffset = String(getDashboardConfig().timezoneOffset || '+0 hours');
        this.db
            .prepare(`DELETE FROM model_calls WHERE ts < datetime('now', ?, '-90 days')`)
            .run(tzOffset);
        this.db
            .prepare(`DELETE FROM sessions_snapshot WHERE ts < datetime('now', ?, '-90 days')`)
            .run(tzOffset);
        this.db
            .prepare(`DELETE FROM cooldown_events WHERE ts < datetime('now', ?, '-90 days')`)
            .run(tzOffset);
        this.cleanupEvents();
    }
}
