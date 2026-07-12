import Database, { Database as SQLiteDatabase, Statement } from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

// Ensure data directory exists
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  // Ignore error if it already exists
}

const DB_PATH = join(DATA_DIR, 'metrics.db');

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
    prompt TEXT,
    response TEXT,
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

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    session_id TEXT,
    task_id TEXT,
    project_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS model_health (
    id TEXT PRIMARY KEY,
    model_name TEXT NOT NULL,
    health_status TEXT DEFAULT 'unchecked',
    error_details TEXT DEFAULT 'None',
    last_check TEXT DEFAULT 'None',
    last_success TEXT DEFAULT 'None',
    failure_streak INTEGER DEFAULT 0
);
`;

export class MetricsDB {
  db: SQLiteDatabase;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);

    // Migrations
    const migrations: (string | (() => void))[] = [
      'ALTER TABLE model_calls ADD COLUMN prompt TEXT',
      'ALTER TABLE model_calls ADD COLUMN response TEXT',
      'ALTER TABLE model_health ADD COLUMN failure_streak INTEGER DEFAULT 0',
      () => {
        // Drop UNIQUE constraint on model_calls (SQLite requires table recreate)
        try {
          const tableInfo = this.db
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_calls'")
            .get() as { sql: string } | undefined;
          if (tableInfo && tableInfo.sql.includes('UNIQUE(')) {
            this.db.exec('DROP TABLE IF EXISTS model_calls_old');
            this.db.exec('ALTER TABLE model_calls RENAME TO model_calls_old');
            this.db.exec(`
              CREATE TABLE model_calls (
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
                prompt TEXT,
                response TEXT
              )
            `);
            this.db.exec('INSERT INTO model_calls SELECT * FROM model_calls_old');
            this.db.exec('DROP TABLE model_calls_old');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_calls_ts ON model_calls(ts)');
          }
        } catch (_) {}
      },
    ];

    for (const m of migrations) {
      try {
        if (typeof m === 'function') {
          m();
        } else {
          this.db.prepare(m).run();
        }
      } catch (e: unknown) {
        if (e instanceof Error && !e.message.includes('duplicate column name')) {
          console.warn('[MetricsDB] Migration warning:', e.message);
        }
      }
    }
  }

  query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params) as Record<string, unknown>[];
  }

  get(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
    return this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  }

  prepare(sql: string): Statement {
    return this.db.prepare(sql);
  }
}
