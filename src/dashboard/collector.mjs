import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "..", "dashboard", "metrics.db");
const HYDRA_DIR = join(__dirname, "..", "..", ".hydra");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS model_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost REAL DEFAULT 0.0,
    status TEXT DEFAULT 'ok',
    session_id TEXT DEFAULT '',
    UNIQUE(ts, provider, model, session_id)
);

CREATE TABLE IF NOT EXISTS daily_agg (
    date TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost REAL DEFAULT 0.0,
    errors INTEGER DEFAULT 0,
    PRIMARY KEY (date, provider, model)
);

CREATE TABLE IF NOT EXISTS cooldown_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT DEFAULT '',
    until TEXT DEFAULT '',
    reason TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_key TEXT NOT NULL,
    model TEXT DEFAULT '',
    agent TEXT DEFAULT '',
    channel TEXT DEFAULT '',
    context_pct REAL DEFAULT 0,
    total_tokens INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_calls_ts ON model_calls(ts);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_agg(date);
`;

export class MetricsCollector {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  // Used by the dashboard API to run raw queries
  query(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  get(sql, params = []) {
    return this.db.prepare(sql).get(...params);
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

    const insertCall = this.db.prepare(`
      INSERT OR IGNORE INTO model_calls 
      (ts, provider, model, input_tokens, output_tokens, total_tokens, cost, status, session_id) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    insertCall.run(ts, provider, fullModel, inp, out, tt, cost, status, data.sessionId || '');
    this.updateDailyAgg();
  }

  updateDailyAgg() {
    this.db.exec(`
      INSERT OR REPLACE INTO daily_agg (date, provider, model, calls, input_tokens, output_tokens, total_tokens, cost, errors)
      SELECT
          substr(ts, 1, 10) as date,
          provider,
          model,
          COUNT(*) as calls,
          SUM(input_tokens),
          SUM(output_tokens),
          SUM(total_tokens),
          SUM(cost),
          SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END)
      FROM model_calls
      WHERE ts >= datetime('now', '+2 hours', '-14 days')
      GROUP BY date, provider, model
    `);
  }

  snapshotSessions() {
    const statePath = join(HYDRA_DIR, "loop-state.json");
    if (!existsSync(statePath)) return;
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      const phase = state.phase || 'idle';
      if (phase !== 'idle') {
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const project = state.project || 'unknown';
        this.db.prepare(`
          INSERT INTO sessions_snapshot (ts, session_key, model, agent, channel, context_pct, total_tokens)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(ts, `${project}:${phase}`, "opencode", phase, "bridge", 0.0, 0);
      }
    } catch {}
  }

  cleanupOld() {
    this.db.prepare("DELETE FROM model_calls WHERE ts < datetime('now', '+2 hours', '-14 days')").run();
    this.db.prepare("DELETE FROM sessions_snapshot WHERE ts < datetime('now', '+2 hours', '-7 days')").run();
    this.db.prepare("DELETE FROM cooldown_events WHERE ts < datetime('now', '+2 hours', '-7 days')").run();
  }
}
