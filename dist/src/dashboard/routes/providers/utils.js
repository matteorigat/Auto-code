import crypto from 'node:crypto';
import config from '../../../config/index.js';
export function formatDateTime(date) {
    const d = new Date(date);
    if (isNaN(d.getTime()))
        return null;
    return d.toISOString();
}
export async function runModelHealthProbe(modelName) {
    try {
        const res = await fetch(`${config.modelRouter.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
            }),
            signal: AbortSignal.timeout(30000),
        });
        if (res.ok) {
            return { status: 'healthy', errorDetails: 'No errors' };
        }
        else {
            let errMsg = `HTTP ${res.status}`;
            try {
                const json = (await res.json());
                if (json.error && typeof json.error === 'object' && json.error.message) {
                    errMsg = json.error.message;
                }
                else if (json.error) {
                    errMsg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
                }
            }
            catch {
                // Ignore invalid JSON format
            }
            return { status: 'unhealthy', errorDetails: errMsg };
        }
    }
    catch (err) {
        const error = err;
        let errMsg = error.message || String(err);
        if (error.name === 'TimeoutError' || errMsg.includes('timeout')) {
            errMsg = 'TimeoutError: 408';
        }
        else if (errMsg.includes('ECONNREFUSED')) {
            errMsg = 'ConnectionRefusedError: model-router not running';
        }
        return { status: 'unhealthy', errorDetails: errMsg };
    }
}
export function getUniqueModels(collector) {
    const dbRows = collector.query('SELECT * FROM model_health');
    const uniqueMap = new Map();
    for (const r of dbRows) {
        const dbModelName = String(r.model_name || '');
        if (!dbModelName)
            continue;
        let provider = 'unknown';
        if (dbModelName.includes('/')) {
            provider = dbModelName.split('/')[0];
        }
        if (!uniqueMap.has(dbModelName)) {
            uniqueMap.set(dbModelName, {
                actual_model: dbModelName,
                provider,
                aliases: [],
            });
        }
    }
    const results = [];
    for (const [actualModel, entry] of uniqueMap.entries()) {
        const id = crypto.createHash('sha256').update(actualModel).digest('hex');
        const dbRow = collector.get('SELECT * FROM model_health WHERE id = ?', [id]);
        const healthRow = dbRow || {};
        results.push({
            id,
            actual_model: actualModel,
            provider: entry.provider,
            aliases: entry.aliases,
            health_status: healthRow.health_status || 'unchecked',
            error_details: healthRow.error_details === 'None' ? null : (healthRow.error_details ?? null),
            last_check: healthRow.last_check === 'None' ? null : (healthRow.last_check ?? null),
            last_success: healthRow.last_success === 'None' ? null : (healthRow.last_success ?? null),
            failure_streak: healthRow.failure_streak || 0,
        });
    }
    return results;
}
