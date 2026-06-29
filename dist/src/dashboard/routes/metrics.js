import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const OR_API_KEY = () => process.env.OMNIROUTE_API_KEY || process.env.API_KEY_SECRET || '';
async function fetchOmniRoute(path, params) {
    const apiKey = OR_API_KEY();
    if (!apiKey)
        return null;
    try {
        const query = params ? '?' + new URLSearchParams(params).toString() : '';
        const res = await fetch(`http://127.0.0.1:20128${path}${query}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
export function createMetricsRouter({ collector, config }) {
    const router = Router();
    const DASHBOARD_DIR = join(process.cwd(), 'dashboard');
    const TZ_OFFSET = config.dashboard?.timezoneOffset || '+0 hours';
    function toDbTs(iso) {
        return iso.replace('T', ' ').replace('Z', '').substring(0, 19);
    }
    function dateFilter(params) {
        const { from, to } = params;
        const clauses = [];
        const vals = [];
        if (from) {
            clauses.push('date >= ?');
            vals.push(from.substring(0, 10));
        }
        if (to) {
            clauses.push('date <= ?');
            vals.push(to.substring(0, 10));
        }
        const clause = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        return { clause, vals };
    }
    function tsFilter(params) {
        const { from, to } = params;
        const conds = [];
        const vals = [];
        if (from) {
            conds.push('ts >= ?');
            vals.push(toDbTs(from));
        }
        if (to) {
            conds.push('ts <= ?');
            vals.push(toDbTs(to));
        }
        return { conds, vals };
    }
    router.get('/summary', async (req, res, next) => {
        try {
            const df = dateFilter(req.query);
            const daily = collector.query(`SELECT provider, model, SUM(calls) as total_calls, SUM(cost) as total_cost FROM daily_agg ${df.clause} GROUP BY provider, model`, df.vals);
            const overall = collector.get(`SELECT SUM(calls) as total_calls, SUM(input_tokens) as total_in, SUM(output_tokens) as total_out, SUM(cost) as total_cost FROM daily_agg ${df.clause}`, df.vals);
            const todayDate = new Date().toISOString().substring(0, 10);
            const today = collector.get(`SELECT SUM(calls) as total_calls, SUM(cost) as total_cost FROM daily_agg WHERE date = ?`, [todayDate]);
            const errors = collector.get(`SELECT SUM(errors) as total_errors FROM daily_agg ${df.clause}`, df.vals);
            const telemetry = await fetchOmniRoute('/api/telemetry/summary', { windowMs: '86400000' });
            const analytics = await fetchOmniRoute('/api/usage/analytics', { windowMs: '86400000' });
            res.json({
                totalCalls: overall?.total_calls || 0,
                totalCost: overall?.total_cost || 0,
                totalInput: overall?.total_in || 0,
                totalOutput: overall?.total_out || 0,
                todayCalls: today?.total_calls || 0,
                todayCost: today?.total_cost || 0,
                totalErrors: errors?.total_errors || 0,
                byModel: daily || [],
                omniroute: telemetry
                    ? {
                        avgLatencyMs: telemetry.avgLatencyMs,
                        errorRate: telemetry.errorRate,
                        uptime: telemetry.uptime,
                        memoryUsage: telemetry.memoryUsage,
                        activeConnections: telemetry.activeConnections,
                        sessions: telemetry.sessions,
                        latency: {
                            p50: telemetry.p50,
                            p95: telemetry.p95,
                            p99: telemetry.p99,
                            avg: telemetry.avg,
                        },
                        phaseBreakdown: telemetry.phaseBreakdown,
                    }
                    : null,
            });
        }
        catch (e) {
            next(e);
        }
    });
    router.get('/daily', async (req, res, next) => {
        try {
            const df = dateFilter(req.query);
            const data = collector.query(`SELECT date, provider, model, calls, input_tokens, output_tokens, total_tokens, cost, errors FROM daily_agg ${df.clause} ORDER BY date DESC, calls DESC LIMIT 500`, df.vals);
            let orDaily = null;
            const orHistory = await fetchOmniRoute('/api/usage/history');
            if (orHistory && Array.isArray(orHistory)) {
                orDaily = orHistory;
            }
            res.json({
                local: data,
                omniroute: orDaily,
            });
        }
        catch (e) {
            next(e);
        }
    });
    router.get('/calls', (req, res, next) => {
        try {
            const query = req.query;
            const { from, to, days } = query;
            const conds = [];
            const params = [];
            if (from || to) {
                const tf = tsFilter(query);
                conds.push(...tf.conds);
                params.push(...tf.vals);
            }
            else if (days) {
                conds.push("ts >= datetime('now', ?, ?)");
                params.push(TZ_OFFSET, `-${days} days`);
            }
            const whereClause = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
            const data = collector.query(`SELECT ts, provider, model, input_tokens, output_tokens, total_tokens, status, prompt, response FROM model_calls ${whereClause} ORDER BY ts DESC LIMIT 200`, params);
            res.json(data);
        }
        catch (e) {
            next(e);
        }
    });
    router.get('/sessions', (req, res, next) => {
        try {
            const tf = tsFilter(req.query);
            const whereClause = tf.conds.length ? 'WHERE ' + tf.conds.join(' AND ') : '';
            const data = collector.query(`SELECT ts, session_key, model, agent, channel, context_pct, total_tokens FROM sessions_snapshot ${whereClause} ORDER BY ts DESC LIMIT 50`, tf.vals);
            res.json(data);
        }
        catch (e) {
            next(e);
        }
    });
    router.get('/models-ref', (req, res, next) => {
        try {
            const refPath = join(DASHBOARD_DIR, 'models-ref.json');
            if (existsSync(refPath)) {
                res.json(JSON.parse(readFileSync(refPath, 'utf8')));
            }
            else {
                const err = new Error('models-ref.json not found');
                err.status = 404;
                throw err;
            }
        }
        catch (e) {
            next(e);
        }
    });
    return router;
}
