#!/usr/bin/env python3
"""
OpenCode Model Usage Collector
Reads LiteLLM proxy trajectory files and bridge state,
aggregates into a local SQLite database for historical tracking.

Ensures:
- No duplicate entries (tracks processed files)
- Atomic transactions (all-or-nothing per run)
- Italian timezone (CEST)
- Standalone operation, bound only to opencode-bridge-telegram
"""

import glob
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone

BASE_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(BASE_DIR, "metrics.db")
# File used to track which files have been processed (name + size + mtime)
PROCESSED_LOG = os.path.join(BASE_DIR, ".processed_files.json")

SCHEMA = """
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
"""

def it_now_str():
    """Current time in Italian timezone (CEST = UTC+2)."""
    return (datetime.now(timezone.utc) + timedelta(hours=2)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )

def parse_ts(s):
    """Parse ISO timestamp and convert to Italian time."""
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        dt += timedelta(hours=2)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except:
        return s[:19] if s else it_now_str()

def file_fingerprint(path):
    """Return (size, mtime) tuple to detect changes."""
    try:
        st = os.stat(path)
        return (st.st_size, st.st_mtime_ns)
    except:
        return None

def load_processed():
    if os.path.exists(PROCESSED_LOG):
        try:
            with open(PROCESSED_LOG) as f:
                return json.load(f)
        except:
            pass
    return {}

def save_processed(data):
    with open(PROCESSED_LOG, "w") as f:
        json.dump(data, f)

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")  # safer writes
    conn.execute("PRAGMA synchronous=NORMAL")  # balance perf/safety
    conn.executescript(SCHEMA)
    return conn

def collect_trajectory(conn):
    """Parse trajectory files, skip already-processed ones."""
    cursor = conn.cursor()
    bridge_pattern = os.path.join(BASE_DIR, "..", ".hydra", "usage_logs*.jsonl")
    files = sorted(glob.glob(bridge_pattern))
    processed = load_processed()
    new_count = 0
    updated = dict(processed)

    for path in files:
        fp = file_fingerprint(path)
        # Skip if already processed and unchanged
        if path in processed and processed[path] == list(fp):
            continue

        rows = []
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    obj = json.loads(line)
                    if obj.get("type") != "model.completed":
                        continue
                    provider = obj.get("provider", "")
                    model_id = obj.get("modelId", "")
                    if not provider or not model_id:
                        continue
                    full_model = f"{provider}/{model_id}"
                    ts = parse_ts(obj.get("ts", ""))
                    data = obj.get("data", {}) or {}
                    pc = data.get("promptCache", {}) or {}
                    usage = pc.get("lastCallUsage", {}) or {}
                    inp = int(usage.get("input", 0))
                    out = int(usage.get("output", 0))
                    tt = int(usage.get("totalTokens", 0))
                    if tt == 0 and (inp > 0 or out > 0):
                        tt = inp + out  # fallback: calculate from i/o
                    cost_obj = usage.get("cost", {}) or {}
                    cost = (
                        float(cost_obj.get("total", 0))
                        if isinstance(cost_obj, dict)
                        else 0
                    )

                    status = "ok"
                    prompt_err = data.get("promptError") or data.get("terminalError")
                    if prompt_err:
                        status = "error"
                    if data.get("timedOut"):
                        status = "timeout"
                    if "overflow" in str(prompt_err).lower():
                        status = "overflow"

                    rows.append(
                        (
                            ts,
                            provider,
                            full_model,
                            inp,
                            out,
                            tt,
                            cost,
                            status,
                            obj.get("sessionId", ""),
                        )
                    )

            # Batch insert with IGNORE to skip true duplicates
            cursor.executemany(
                "INSERT OR IGNORE INTO model_calls (ts, provider, model, input_tokens, output_tokens, total_tokens, cost, status, session_id) VALUES (?,?,?,?,?,?,?,?,?)",
                rows,
            )
            new_count += len(rows)
            updated[path] = list(fp)
        except Exception as e:
            print(f"[collector] error reading {path}: {e}")
            # Do NOT mark as processed so it retries next time

    print(f"[collector] trajectory: {len(files)} files, {new_count} new rows")
    return updated  # Return to be saved inside the transaction

def collect_sessions(conn):
    """Snapshot current sessions from bridge state."""
    cursor = conn.cursor()
    now = it_now_str()
    state_path = os.path.join(BASE_DIR, "..", ".hydra", "loop-state.json")
    try:
        if os.path.exists(state_path):
            with open(state_path) as f:
                state = json.load(f)
            
            project = state.get("project", "unknown")
            phase = state.get("phase", "idle")
            if phase != "idle":
                cursor.execute(
                    "INSERT INTO sessions_snapshot (ts, session_key, model, agent, channel, context_pct, total_tokens) VALUES (?,?,?,?,?,?,?)",
                    (now, f"{project}:{phase}", "opencode", phase, "bridge", 0.0, 0),
                )
    except Exception as e:
        print(f"[collector] sessions error: {e}")

def build_daily_agg(conn):
    """Aggregate model_calls into daily_agg (Italian dates)."""
    cursor = conn.cursor()
    cursor.execute("""
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
        WHERE ts >= datetime('now', '+2 hours', '-90 days')
        GROUP BY date, provider, model
        ON CONFLICT(date, provider, model) DO UPDATE SET
            calls = excluded.calls,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            total_tokens = excluded.total_tokens,
            cost = excluded.cost,
            errors = excluded.errors
    """)
    print(f"[collector] daily agg: {cursor.rowcount} rows affected")

def cleanup_old(conn):
    """Prune old data: keep 90 days of calls, 7 days of sessions/cooldowns."""
    cursor = conn.cursor()
    cursor.execute(
        "DELETE FROM model_calls WHERE ts < datetime('now', '+2 hours', '-90 days')"
    )
    cursor.execute(
        "DELETE FROM sessions_snapshot WHERE ts < datetime('now', '+2 hours', '-7 days')"
    )
    cursor.execute(
        "DELETE FROM cooldown_events WHERE ts < datetime('now', '+2 hours', '-7 days')"
    )
    print(f"[collector] cleanup: purged old data")

def run():
    print(f"[collector] run at {it_now_str()}")
    # Prune stale processed file entries (files that no longer exist)
    known = set()
    for p in glob.glob(os.path.join(BASE_DIR, "..", ".hydra", "usage_logs*.jsonl")):
        known.add(p)
    old_proc = load_processed()
    for k in list(old_proc.keys()):
        if k not in known:
            del old_proc[k]
    save_processed(old_proc)
    conn = get_db()
    try:
        # All operations in ONE transaction
        conn.execute("BEGIN")
        proc = collect_trajectory(conn)
        collect_sessions(conn)
        build_daily_agg(conn)
        conn.commit()
        save_processed(proc)
        cleanup_old(conn)
        print("[collector] done - all committed")
    except Exception as e:
        conn.rollback()
        print(f"[collector] ERROR: {e} - rolled back")
    finally:
        conn.close()

if __name__ == "__main__":
    run()
