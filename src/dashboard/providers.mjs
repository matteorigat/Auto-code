import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROVIDERS = [
  {
    id: "openrouter",
    label: "OpenRouter",
    env_keys: ["OPENROUTER_API_KEY"],
    base_url: "https://openrouter.ai/api/v1",
    docs_url: "https://openrouter.ai/docs",
    model_prefix: "openrouter/",
    key_info_path: "/key",
    notes: "Espone /key con usage e crediti residui."
  },
  {
    id: "groq",
    label: "Groq",
    env_keys: ["GROQ_API_KEY"],
    base_url: "https://api.groq.com/openai/v1",
    docs_url: "https://console.groq.com/docs",
    model_prefix: "groq/",
    notes: "Limiti via header x-ratelimit-* sulle risposte."
  },
  {
    id: "mistral",
    label: "Mistral",
    env_keys: ["MISTRAL_API_KEY"],
    base_url: "https://api.mistral.ai/v1",
    docs_url: "https://docs.mistral.ai",
    model_prefix: "mistral/",
    notes: "Catalogo via API; limiti/tier nel pannello Admin."
  },
  {
    id: "kilo",
    label: "Kilo Gateway",
    env_keys: ["KILO_API_KEY"],
    base_url: "https://api.kilo.ai/api/gateway",
    docs_url: "https://kilo.ai/docs/gateway",
    model_prefix: "kilo/",
    notes: "Gateway OpenAI-compatible."
  },
  {
    id: "cerebras",
    label: "Cerebras",
    env_keys: ["CEREBRAS_API_KEY", "CEREBRAL_API_KEY"],
    base_url: "https://api.cerebras.ai/v1",
    docs_url: "https://inference-docs.cerebras.ai",
    model_prefix: "cerebras/",
    notes: "Endpoint OpenAI-compatible."
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    env_keys: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
    base_url: "https://integrate.api.nvidia.com/v1",
    docs_url: "https://docs.nvidia.com/nim/",
    model_prefix: "nvidia/",
    notes: "Endpoint OpenAI-compatible."
  }
];

function loadEnv() {
  const env = {};
  const paths = [
    join(__dirname, "..", "..", ".env"),
    join(homedir(), ".openclaw", ".env")
  ];
  
  for (const p of paths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8');
      for (let line of content.split('\n')) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.substring(7).trim();
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const k = line.substring(0, eqIdx).trim();
        let v = line.substring(eqIdx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.substring(1, v.length - 1);
        }
        env[k] = v;
      }
    }
  }
  return env;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const num = Number(v);
  return isNaN(num) ? null : num;
}

function rateMetrics(headers) {
  const h = {};
  headers.forEach((v, k) => h[k.toLowerCase()] = v);
  const metrics = [];
  const pairs = [
    ["requests", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"],
    ["tokens", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"],
    ["input tokens", "x-ratelimit-limit-input-tokens", "x-ratelimit-remaining-input-tokens", "x-ratelimit-reset-input-tokens"],
    ["output tokens", "x-ratelimit-limit-output-tokens", "x-ratelimit-remaining-output-tokens", "x-ratelimit-reset-output-tokens"]
  ];
  
  for (const [label, lk, rk, rsk] of pairs) {
    const limit = parseNum(h[lk]);
    const remaining = parseNum(h[rk]);
    if (limit == null && remaining == null) continue;
    let used = null;
    let pct = null;
    if (limit != null && remaining != null) {
      used = Math.max(limit - remaining, 0);
      pct = limit ? parseFloat(((used / limit) * 100).toFixed(1)) : null;
    }
    metrics.push({
      label, limit, remaining, used, pct_used: pct, reset: h[rsk]
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
    data = payload.data || payload.models || payload.items || [];
  } else if (Array.isArray(payload)) {
    data = payload;
  }
  
  if (!Array.isArray(data)) data = [];
  const models = [];
  
  for (const item of data) {
    let mid = null;
    if (typeof item === 'string') {
      mid = item;
    } else if (item && typeof item === 'object') {
      mid = item.id || item.name || item.model || item.slug;
    }
    if (!mid) continue;
    
    let ctx = null;
    if (item && typeof item === 'object') {
      for (const k of ["context_length", "context_window", "max_context_length", "max_input_tokens", "max_tokens"]) {
        if (item[k] != null) {
          ctx = parseInt(item[k], 10);
          if (!isNaN(ctx)) break;
          else ctx = null;
        }
      }
    }
    
    let isFree = false;
    if (item && typeof item === 'object') {
      if (String(mid).endsWith(':free') || String(item.tier || '').toLowerCase() === 'free') {
        isFree = true;
      }
      const pricing = item.pricing || item.price || {};
      if (typeof pricing === 'object') {
        const vals = Object.values(pricing).map(v => parseFloat(v)).filter(v => !isNaN(v));
        if (vals.length > 0 && vals.every(v => v === 0)) {
          isFree = true;
        }
      }
    }
    models.push({ id: mid, context: ctx, free: isFree });
  }
  return models.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
}

export async function auditProviders(probe = false) {
  const env = loadEnv();
  const results = [];
  
  for (const prov of PROVIDERS) {
    let api_key = null;
    for (const ek of prov.env_keys) {
      api_key = env[ek] || process.env[ek];
      if (api_key) break;
    }
    
    const audit = {
      id: prov.id,
      label: prov.label,
      configured: !!api_key,
      key_masked: api_key ? (api_key.length > 10 ? `${api_key.substring(0,6)}...${api_key.substring(api_key.length-4)}` : '...') : null,
      ok: false,
      status: api_key ? 'pending' : 'no_key',
      errors: [],
      notes: prov.notes ? [prov.notes] : [],
      account: null,
      models: [],
      free_models: 0,
      rate_metrics: [],
      probe_result: null,
      docs_url: prov.docs_url
    };
    
    if (!api_key) {
      results.push(audit);
      continue;
    }
    
    const headers = {
      'Authorization': `Bearer ${api_key}`,
      'Accept': 'application/json'
    };
    
    // 1. Key Info
    if (prov.key_info_path) {
      try {
        const res = await fetch(`${prov.base_url.replace(/\/$/, '')}${prov.key_info_path}`, { headers, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          audit.account = await res.json();
        } else {
          audit.errors.push(`key_info HTTP ${res.status}`);
        }
      } catch (e) {
        audit.errors.push(`key_info err: ${e.message}`);
      }
    }
    
    // 2. Model Catalog
    try {
      const res = await fetch(`${prov.base_url.replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const catalog = extractModels(data);
        audit.models = catalog.slice(0, 100);
        audit.free_models = catalog.filter(m => m.free).length;
        audit.ok = true;
        audit.status = 'ok';
      } else {
        audit.status = 'error';
        audit.errors.push(`models HTTP ${res.status}`);
      }
    } catch (e) {
      audit.status = 'error';
      audit.errors.push(`models err: ${e.message}`);
    }
    
    // 3. Micro Probe
    if (probe && audit.models.length > 0) {
      let probeModel = null;
      for (const m of audit.models) {
        const mid = String(m.id);
        if (!mid.endsWith('/auto') && !mid.toLowerCase().includes('embed') && !mid.toLowerCase().includes('whisper')) {
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
            temperature: 0
          });
          const res = await fetch(`${prov.base_url.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(10000)
          });
          
          const probeHeaders = res.headers;
          if (res.ok) {
            const probeData = await res.json();
            audit.probe_result = {
              ok: true,
              model: probeModel,
              status_code: res.status,
              usage: probeData.usage || {}
            };
          } else {
            audit.probe_result = {
              ok: false,
              model: probeModel,
              status_code: res.status,
              error: String(res.status)
            };
          }
          audit.rate_metrics = rateMetrics(probeHeaders);
        } catch (e) {
          audit.probe_result = { ok: false, model: probeModel, error: e.message };
        }
      } else {
        audit.probe_result = { ok: false, error: 'Nessun modello testabile.' };
      }
    }
    results.push(audit);
  }
  
  return {
    summary: {
      providers: results.length,
      configured: results.filter(r => r.configured).length,
      ok: results.filter(r => r.ok).length,
      models_total: results.reduce((acc, r) => acc + (r.models ? r.models.length : 0), 0),
      free_models: results.reduce((acc, r) => acc + (r.free_models || 0), 0)
    },
    providers: results
  };
}
