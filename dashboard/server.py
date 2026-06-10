#!/usr/bin/env python3
"""
OpenClaw Model Tracker Server
Serves dashboard HTML + API from local SQLite database.
"""

import http.server
import json
import os
import socketserver
import sqlite3
import urllib.request
from datetime import datetime, timezone

from providers import audit_providers

DB_PATH = os.path.join(os.path.dirname(__file__), "metrics.db")
HTML_PATH = os.path.join(os.path.dirname(__file__), "index.html")
DASHBOARD_API = "http://100.75.223.3:8081"

# Italian timezone offset (CEST = UTC+2 in June)
TZ = "+2 hours"
IT_NOW = f"datetime('now', '{TZ}')"
IT_DATE = f"date('now', '{TZ}')"
IT_DATE_MINUS_1 = f"date('now', '{TZ}', '-1 day')"
IT_WEEK = f"date('now', '{TZ}', 'weekday 1', '-7 days')"
IT_MONTH = f"date('now', '{TZ}', 'start of month')"
IT_NOW_MINUS_1M = f"datetime('now', '{TZ}', '-1 minute')"
IT_NOW_MINUS_1H = f"datetime('now', '{TZ}', '-1 hour')"
IT_NOW_MINUS_24H = f"datetime('now', '{TZ}', '-24 hours')"
IT_NOW_MINUS_7D = f"datetime('now', '{TZ}', '-7 days')"
IT_NOW_MINUS_30D = f"datetime('now', '{TZ}', '-30 days')"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def query(sql, params=()):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


class Handler(http.server.SimpleHTTPRequestHandler):
    def _route(self):
        return self.path.split("?", 1)[0]

    def do_GET(self):
        path = self._route()
        if path == "/api/collect":
            # Run collector in background thread to not block the server
            import subprocess as _sp
            import threading as _t

            def _run_collector():
                try:
                    _sp.run(
                        ["python3", "-S", "collector.py"],
                        capture_output=True,
                        timeout=120,
                        cwd=os.path.dirname(__file__),
                    )
                except:
                    pass

            _t.Thread(target=_run_collector, daemon=True).start()
            self.send_json({"status": "started"})
        elif path == "/api/daily":
            self.send_json(
                query(
                    "SELECT date, provider, model, calls, input_tokens, output_tokens, total_tokens, cost, errors "
                    "FROM daily_agg ORDER BY date DESC, calls DESC LIMIT 500"
                )
            )
        elif path == "/api/calls":
            days = self._param("days", "7")
            dt = f"-{days} days"
            self.send_json(
                query(
                    f"SELECT ts, provider, model, input_tokens, output_tokens, total_tokens, status "
                    f"FROM model_calls WHERE ts >= datetime('now', '+2 hours', ?) ORDER BY ts DESC LIMIT 200",
                    (dt,),
                )
            )
        elif path == "/api/sessions":
            self.send_json(
                query(
                    "SELECT ts, session_key, model, agent, channel, context_pct, total_tokens "
                    "FROM sessions_snapshot ORDER BY ts DESC LIMIT 50"
                )
            )
        elif path == "/api/models-ref":
            import json as j

            ref_path = os.path.join(os.path.dirname(__file__), "models-ref.json")
            try:
                with open(ref_path) as f:
                    self.send_json(j.load(f))
            except Exception as e:
                self.send_json({"error": str(e)}, 404)
        elif path == "/api/providers/audit":
            probe = self._param("probe", "0") == "1"
            self.send_json(audit_providers(probe=probe))
        elif path == "/api/cooldowns":
            self.send_json(
                query(
                    "SELECT ts, provider, reason FROM cooldown_events ORDER BY ts DESC LIMIT 50"
                )
            )
        elif path == "/api/bridge-state":
            state_path = os.path.join(os.path.dirname(__file__), "..", ".hydra", "loop-state.json")
            try:
                with open(state_path) as f:
                    self.send_json(json.load(f))
            except Exception as e:
                self.send_json({"error": "Bridge not running or state missing", "details": str(e)}, 404)
        elif path == "/api/sysinfo":
            try:
                import psutil
                import shutil
                mem = psutil.virtual_memory()
                disk = shutil.disk_usage("/")
                self.send_json({
                    "cpu_pct": psutil.cpu_percent(interval=0.1),
                    "ram_used": mem.used,
                    "ram_total": mem.total,
                    "ram_pct": mem.percent,
                    "disk_used": disk.used,
                    "disk_total": disk.total,
                    "disk_pct": (disk.used / disk.total) * 100
                })
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
        elif path == "/api/routing-chain":
            try:
                config_path = os.path.join(os.path.dirname(__file__), "litellm-config.yaml")
                tiers = {}
                current_tier = None
                with open(config_path) as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("- model_name:"):
                            current_tier = line.split(":", 1)[1].strip()
                            if current_tier not in tiers:
                                tiers[current_tier] = []
                        elif line.startswith("model:") and current_tier:
                            m = line.split(":", 1)[1].strip().strip("'\"")
                            provider = m.split("/")[0] if "/" in m else ""
                            tiers[current_tier].append({"model": m, "provider": provider, "status": "standby"})

                today_ok_prov = query(f"SELECT provider, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok_calls FROM model_calls WHERE ts >= {IT_DATE} GROUP BY provider")
                today_ok_map = {r["provider"]: r["ok_calls"] for r in today_ok_prov}

                rate_limits = {}
                ref_path = os.path.join(os.path.dirname(__file__), "models-ref.json")
                try:
                    with open(ref_path) as f:
                        import json as j
                        for m in j.load(f):
                            p = m.get("provider", "")
                            if p not in rate_limits:
                                rate_limits[p] = {"rpd": 0}
                            if m.get("rpd"):
                                rate_limits[p]["rpd"] = max(rate_limits[p]["rpd"], m["rpd"])
                except:
                    pass

                recent_calls = query(f"SELECT model, status, ts FROM model_calls WHERE ts >= {IT_NOW_MINUS_1H} ORDER BY ts DESC LIMIT 500")
                
                model_errors = {}
                for c in recent_calls:
                    m = c["model"]
                    if c["status"] != "ok":
                        # Solo gli errori recentissimi contano come exhausted per limit (es ultimi 10 min)
                        model_errors[m] = model_errors.get(m, 0) + 1

                for t_name, m_list in tiers.items():
                    tier_models = [m["model"] for m in m_list]
                    tier_active = None
                    for c in recent_calls:
                        if c["status"] == "ok" and c["model"] in tier_models:
                            tier_active = c["model"]
                            break
                    
                    for m in m_list:
                        p = m["provider"]
                        rpd_limit = rate_limits.get(p, {}).get("rpd", 0)
                        today_ok = today_ok_map.get(p, 0)
                        
                        if rpd_limit and today_ok >= rpd_limit:
                            m["status"] = "exhausted"
                            m["reason"] = "RPD Limit"
                        elif model_errors.get(m["model"], 0) > 3:
                            m["status"] = "exhausted"
                            m["reason"] = "Errors"
                        elif m["model"] == tier_active:
                            m["status"] = "active"
                        else:
                            m["status"] = "standby"

                self.send_json(tiers)
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
        elif path == "/api/summary":
            self.send_json(self.handle_summary())
        elif self.path.startswith("/api/proxy/"):
            target = self.path.replace("/api/proxy/", DASHBOARD_API + "/", 1)
            try:
                resp = urllib.request.urlopen(target, timeout=5)
                self.send_json(json.loads(resp.read()))
            except Exception as e:
                self.send_json({"error": str(e)}, 502)
        else:
            super().do_GET()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_POST(self):
        path = self._route()
        if path == "/api/bridge-cmd":
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            cmd_path = os.path.join(os.path.dirname(__file__), "..", ".hydra", "bridge-cmd.json")
            try:
                payload = json.loads(post_data.decode('utf-8'))
                payload['ts'] = datetime.now(timezone.utc).isoformat()
                with open(cmd_path, "w") as f:
                    json.dump(payload, f)
                self.send_json({"status": "ok"})
            except Exception as e:
                self.send_json({"error": "Failed to write command", "details": str(e)}, 500)
        else:
            self.send_response(404)
            self.end_headers()

    def _param(self, name, default=None):
        from urllib.parse import parse_qs, urlparse

        qs = parse_qs(urlparse(self.path).query)
        return qs.get(name, [default])[0]

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def handle_stats(self, range_filter="all"):
        # Build WHERE clause based on range (Italian time)
        where = ""
        range_label = "All Time"
        if range_filter == "1m":
            where = f"WHERE ts >= {IT_NOW_MINUS_1M}"
            range_label = "Last Minute"
        elif range_filter == "1h":
            where = f"WHERE ts >= {IT_NOW_MINUS_1H}"
            range_label = "Last Hour"
        elif range_filter == "today":
            where = f"WHERE ts >= {IT_DATE}"
            range_label = "Today"
        elif range_filter == "yesterday":
            where = f"WHERE ts >= {IT_DATE_MINUS_1} AND ts < {IT_DATE}"
            range_label = "Yesterday"
        elif range_filter == "24h":
            where = f"WHERE ts >= {IT_NOW_MINUS_24H}"
            range_label = "Last 24h"
        elif range_filter == "7d":
            where = f"WHERE ts >= {IT_NOW_MINUS_7D}"
            range_label = "Last 7 Days"
        elif range_filter == "thisweek":
            where = f"WHERE ts >= {IT_WEEK}"
            range_label = "This Week"
        elif range_filter == "30d":
            where = f"WHERE ts >= {IT_NOW_MINUS_30D}"
            range_label = "Last 30 Days"
        elif range_filter == "thismonth":
            where = f"WHERE ts >= {IT_MONTH}"
            range_label = "This Month"

        total_q = f"SELECT COUNT(*) as total_calls, COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(cost),0) as total_cost, SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END) as total_errors FROM model_calls {where}"
        by_model_q = f"SELECT model, COUNT(*) as calls, SUM(input_tokens) as inp, SUM(output_tokens) as out, SUM(total_tokens) as total, SUM(cost) as cost, SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END) as errors FROM model_calls {where} GROUP BY model ORDER BY calls DESC LIMIT 50"
        by_provider_q = f"SELECT provider, COUNT(*) as calls, SUM(total_tokens) as tokens, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok_calls, SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END) as err_calls FROM model_calls {where} GROUP BY provider ORDER BY calls DESC"
        by_status_q = f"SELECT status, COUNT(*) as cnt FROM model_calls {where} GROUP BY status ORDER BY cnt DESC"

        daily = query(
            "SELECT date, SUM(calls) as calls, SUM(total_tokens) as tokens, SUM(cost) as cost, SUM(errors) as errors "
            "FROM daily_agg GROUP BY date ORDER BY date DESC LIMIT 90"
        )
        total = query(total_q)
        today = (
            query(by_provider_q)[:1]
            if range_filter == "1m"
            else query(
                f"SELECT COUNT(*) as calls, COALESCE(SUM(total_tokens),0) as tokens, COALESCE(SUM(cost),0) as cost "
                f"FROM model_calls WHERE ts >= {IT_DATE}"
            )
        )

        # Load rate limits from models-ref.json and merge with actual usage
        rate_limits = {}
        ref_path = os.path.join(os.path.dirname(__file__), "models-ref.json")
        try:
            with open(ref_path) as f:
                for m in json.load(f):
                    prov = m.get("provider", "")
                    if prov not in rate_limits:
                        rate_limits[prov] = {"rpm": set(), "tpd": set(), "rpd": set()}
                    if m.get("rpm"):
                        rate_limits[prov]["rpm"].add(m["rpm"])
                    if m.get("tpd"):
                        rate_limits[prov]["tpd"].add(m["tpd"])
                    if m.get("rpd"):
                        rate_limits[prov]["rpd"].add(m["rpd"])
        except:
            pass
        # Flatten sets to max values
        rate_summary = {}
        for prov, limits in rate_limits.items():
            rate_summary[prov] = {
                "rpm": max(limits["rpm"]) if limits["rpm"] else None,
                "tpd": max(limits["tpd"]) if limits["tpd"] else None,
                "rpd": max(limits["rpd"]) if limits["rpd"] else None,
            }

        # Get today's usage for per-provider rate tracking (only OK calls for RPD comparison)
        today_prov = query(
            f"SELECT provider, COUNT(*) as calls, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok_calls FROM model_calls WHERE ts >= {IT_DATE} GROUP BY provider"
        )
        today_map = {}
        today_ok_map = {}
        for r in today_prov:
            today_map[r["provider"]] = r["calls"]
            today_ok_map[r["provider"]] = r["ok_calls"]

        # Peak RPM: max OK calls in any single minute for each provider in the selected range
        peak_rpm_q = f"SELECT provider, MAX(cnt) as peak FROM (SELECT provider, substr(ts,1,16) as minute, COUNT(*) as cnt FROM model_calls {'WHERE status=\'ok\'' if not where else where + ' AND status=\'ok\''} GROUP BY provider, minute) GROUP BY provider"
        peak_rpm_list = query(peak_rpm_q)
        peak_rpm_map = {}
        for r in peak_rpm_list:
            peak_rpm_map[r["provider"]] = r["peak"]

        # Enrich provider list with rate limits — include ALL known providers even with 0 calls
        provider_list = query(by_provider_q)
        by_model_list = query(by_model_q)

        # Build a map of real usage by provider
        usage_map = {}
        for r in provider_list:
            usage_map[r["provider"]] = r

        # Merge: all known providers from models-ref + any extra from query
        all_provs = list(rate_summary.keys())
        for r in provider_list:
            if r["provider"] not in all_provs:
                all_provs.append(r["provider"])

        merged = []
        for prov in all_provs:
            usage = usage_map.get(
                prov, {"calls": 0, "ok_calls": 0, "err_calls": 0, "tokens": 0}
            )
            rl = rate_summary.get(prov, {})
            today_ok = today_ok_map.get(prov, 0)
            merged.append(
                {
                    "provider": prov,
                    "calls": usage.get("calls", 0),
                    "ok_calls": usage.get("ok_calls", 0),
                    "err_calls": usage.get("err_calls", 0),
                    "tokens": usage.get("tokens", 0),
                    "rpm_limit": rl.get("rpm"),
                    "rpm_peak": peak_rpm_map.get(prov, 0),
                    "tpd_limit": rl.get("tpd"),
                    "rpd_limit": rl.get("rpd"),
                    "today_ok": today_ok,
                },
            )

        # Sort by calls descending, then alphabetically
        merged.sort(key=lambda x: (-x["calls"], x["provider"]))

        return {
            "total": total[0] if total else {},
            "today": today[0] if today else {},
            "daily": daily,
            "byModel": by_model_list,
            "byProvider": merged,
            "byStatus": query(by_status_q),
            "range": range_label,
        }

    def handle_summary(self):
        # Read range from query string
        from urllib.parse import parse_qs, urlparse

        qs = parse_qs(urlparse(self.path).query)
        range_f = qs.get("range", ["all"])[0]

        # Also fetch live data from dashboard for gateway status
        gw = {"status": "unknown"}
        try:
            resp = urllib.request.urlopen(f"{DASHBOARD_API}/api/refresh", timeout=3)
            live = json.loads(resp.read())
            gw = live.get("gateway", {})
        except:
            pass
        stats = self.handle_stats(range_f)
        stats["gateway"] = gw
        return stats

    def log_message(self, fmt, *args):
        pass


def main():
    port = int(os.environ.get("PORT", "8081"))
    os.chdir(os.path.dirname(__file__))

    # Run collector on startup then every 30 min
    import threading

    def collect_loop():
        import subprocess
        import time

        while True:
            try:
                subprocess.run(
                    ["python3", "-S", "collector.py"], capture_output=True, timeout=120
                )
            except:
                pass
            time.sleep(60)  # 1 min — catch data before OpenClaw rotates logs

    t = threading.Thread(target=collect_loop, daemon=True)
    t.start()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", port), Handler) as httpd:
        print(f"[tracker] on 0.0.0.0:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
