import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDERS = [
    {
        id: 'openrouter',
        label: 'OpenRouter',
        env_keys: ['OPENROUTER_API_KEY'],
        base_url: 'https://openrouter.ai/api/v1',
        docs_url: 'https://openrouter.ai/docs',
        model_prefix: 'openrouter/',
        key_info_path: '/key',
        notes: 'Exposes /key with usage and remaining credits.',
    },
    {
        id: 'groq',
        label: 'Groq',
        env_keys: ['GROQ_API_KEY'],
        base_url: 'https://api.groq.com/openai/v1',
        docs_url: 'https://console.groq.com/docs',
        model_prefix: 'groq/',
        notes: 'Limits via x-ratelimit-* headers on responses.',
    },
    {
        id: 'mistral',
        label: 'Mistral',
        env_keys: ['MISTRAL_API_KEY'],
        base_url: 'https://api.mistral.ai/v1',
        docs_url: 'https://docs.mistral.ai',
        model_prefix: 'mistral/',
        notes: 'Catalog via API; limits/tiers in Admin panel.',
    },
    {
        id: 'kilo',
        label: 'Kilo Gateway',
        env_keys: ['KILO_API_KEY'],
        base_url: 'https://api.kilo.ai/api/gateway',
        docs_url: 'https://kilo.ai/docs/gateway',
        model_prefix: 'kilo/',
        notes: 'Gateway OpenAI-compatible.',
    },
    {
        id: 'cerebras',
        label: 'Cerebras',
        env_keys: ['CEREBRAS_API_KEY', 'CEREBRAL_API_KEY'],
        base_url: 'https://api.cerebras.ai/v1',
        docs_url: 'https://inference-docs.cerebras.ai',
        model_prefix: 'cerebras/',
        notes: 'Endpoint OpenAI-compatible.',
    },
    {
        id: 'nvidia',
        label: 'NVIDIA NIM',
        env_keys: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
        base_url: 'https://integrate.api.nvidia.com/v1',
        docs_url: 'https://docs.nvidia.com/nim/',
        model_prefix: 'nvidia/',
        notes: 'Endpoint OpenAI-compatible.',
    },
];
import config from '../config/index.js';
function parseNum(v) {
    if (v == null || v === '')
        return null;
    const num = Number(v);
    return isNaN(num) ? null : num;
}
function rateMetrics(headers) {
    const h = {};
    headers.forEach((v, k) => (h[k.toLowerCase()] = v));
    const metrics = [];
    const pairs = [
        [
            'requests',
            'x-ratelimit-limit-requests',
            'x-ratelimit-remaining-requests',
            'x-ratelimit-reset-requests',
        ],
        [
            'tokens',
            'x-ratelimit-limit-tokens',
            'x-ratelimit-remaining-tokens',
            'x-ratelimit-reset-tokens',
        ],
        [
            'input tokens',
            'x-ratelimit-limit-input-tokens',
            'x-ratelimit-remaining-input-tokens',
            'x-ratelimit-reset-input-tokens',
        ],
        [
            'output tokens',
            'x-ratelimit-limit-output-tokens',
            'x-ratelimit-remaining-output-tokens',
            'x-ratelimit-reset-output-tokens',
        ],
    ];
    for (const [label, lk, rk, rsk] of pairs) {
        const limit = parseNum(h[lk]);
        const remaining = parseNum(h[rk]);
        if (limit == null && remaining == null)
            continue;
        let used = null;
        let pct = null;
        if (limit != null && remaining != null) {
            used = Math.max(limit - remaining, 0);
            pct = limit ? parseFloat(((used / limit) * 100).toFixed(1)) : null;
        }
        metrics.push({
            label,
            limit,
            remaining,
            used,
            pct_used: pct,
            reset: h[rsk],
        });
    }
    if (h['retry-after']) {
        metrics.push({ label: 'retry-after', value: h['retry-after'] });
    }
    return metrics;
}
function extractModels(payload) {
    let data = [];
    if (payload && typeof payload === 'object') {
        const obj = payload;
        data = obj.data || obj.models || obj.items || [];
    }
    else if (Array.isArray(payload)) {
        data = payload;
    }
    if (!Array.isArray(data))
        data = [];
    const models = [];
    for (const item of data) {
        let mid = null;
        if (typeof item === 'string') {
            mid = item;
        }
        else if (item && typeof item === 'object') {
            const obj = item;
            mid =
                obj.id ||
                    obj.name ||
                    obj.model ||
                    obj.slug ||
                    null;
        }
        if (!mid)
            continue;
        let ctx = null;
        if (item && typeof item === 'object') {
            const obj = item;
            for (const k of [
                'context_length',
                'context_window',
                'max_context_length',
                'max_input_tokens',
                'max_tokens',
            ]) {
                const v = obj[k];
                if (v != null) {
                    ctx = parseInt(String(v), 10);
                    if (!isNaN(ctx))
                        break;
                    else
                        ctx = null;
                }
            }
        }
        let isFree = false;
        let modelName = null;
        if (item && typeof item === 'object') {
            const obj = item;
            if (String(mid).endsWith(':free') || String(obj.tier || '').toLowerCase() === 'free') {
                isFree = true;
            }
            const pricing = obj.pricing || obj.price || {};
            if (typeof pricing === 'object') {
                const vals = Object.values(pricing)
                    .map((v) => parseFloat(String(v)))
                    .filter((v) => !isNaN(v));
                if (vals.length > 0 && vals.every((v) => v === 0)) {
                    isFree = true;
                }
            }
            modelName = obj.name || null;
        }
        models.push({ id: mid, context: ctx, free: isFree, name: modelName });
    }
    return models.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
}
export { PROVIDERS, extractModels };
export async function auditProviders(probe = false) {
    const results = [];
    for (const prov of PROVIDERS) {
        const api_key = config.litellm.providerKeys[prov.id] || null;
        const audit = {
            id: prov.id,
            label: prov.label,
            configured: !!api_key,
            key_masked: api_key
                ? api_key.length > 10
                    ? `${api_key.substring(0, 6)}...${api_key.substring(api_key.length - 4)}`
                    : '...'
                : null,
            ok: false,
            status: api_key ? 'pending' : 'no_key',
            errors: [],
            notes: prov.notes ? [prov.notes] : [],
            account: null,
            models: [],
            free_models: 0,
            rate_metrics: [],
            probe_result: null,
            docs_url: prov.docs_url,
        };
        if (!api_key) {
            results.push(audit);
            continue;
        }
        const headers = {
            Authorization: `Bearer ${api_key}`,
            Accept: 'application/json',
        };
        if (prov.key_info_path) {
            try {
                const res = await fetch(`${prov.base_url.replace(/\/$/, '')}${prov.key_info_path}`, {
                    headers,
                    signal: AbortSignal.timeout(8000),
                });
                if (res.ok) {
                    audit.account = await res.json();
                }
                else {
                    audit.errors.push(`key_info HTTP ${res.status}`);
                }
            }
            catch (e) {
                audit.errors.push(`key_info err: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        try {
            const res = await fetch(`${prov.base_url.replace(/\/$/, '')}/models`, {
                headers,
                signal: AbortSignal.timeout(8000),
            });
            if (res.ok) {
                const data = await res.json();
                const catalog = extractModels(data);
                audit.models = catalog.slice(0, 100);
                audit.free_models = catalog.filter((m) => m.free).length;
                audit.ok = true;
                audit.status = 'ok';
            }
            else {
                audit.status = 'error';
                audit.errors.push(`models HTTP ${res.status}`);
            }
        }
        catch (e) {
            audit.status = 'error';
            audit.errors.push(`models err: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (probe && audit.models.length > 0) {
            let probeModel = null;
            for (const m of audit.models) {
                const mid = String(m.id);
                if (!mid.endsWith('/auto') &&
                    !mid.toLowerCase().includes('embed') &&
                    !mid.toLowerCase().includes('whisper')) {
                    probeModel = mid;
                    break;
                }
            }
            if (probeModel) {
                try {
                    const body = JSON.stringify({
                        model: probeModel,
                        messages: [{ role: 'user', content: 'hi' }],
                        max_tokens: 1,
                        temperature: 0,
                    });
                    const res = await fetch(`${prov.base_url.replace(/\/$/, '')}/chat/completions`, {
                        method: 'POST',
                        headers: { ...headers, 'Content-Type': 'application/json' },
                        body,
                        signal: AbortSignal.timeout(10000),
                    });
                    const probeHeaders = res.headers;
                    if (res.ok) {
                        const probeData = (await res.json());
                        audit.probe_result = {
                            ok: true,
                            model: probeModel,
                            status_code: res.status,
                            usage: (probeData.usage || {}),
                        };
                    }
                    else {
                        audit.probe_result = {
                            ok: false,
                            model: probeModel,
                            status_code: res.status,
                            error: String(res.status),
                        };
                    }
                    audit.rate_metrics = rateMetrics(probeHeaders);
                }
                catch (e) {
                    audit.probe_result = {
                        ok: false,
                        model: probeModel,
                        error: e instanceof Error ? e.message : String(e),
                    };
                }
            }
            else {
                audit.probe_result = { ok: false, error: 'Nessun modello testabile.' };
            }
        }
        results.push(audit);
    }
    return {
        summary: {
            providers: results.length,
            configured: results.filter((r) => r.configured).length,
            ok: results.filter((r) => r.ok).length,
            models_total: results.reduce((acc, r) => acc + r.models.length, 0),
            free_models: results.reduce((acc, r) => acc + r.free_models, 0),
        },
        providers: results,
    };
}
