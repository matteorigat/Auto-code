import { Router } from 'express';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { parse, stringify } from 'yaml';
import config from '../../../config/index.mjs';

export function createDiscoveryRouter({ collector }) {
  const router = Router();
  const CONFIG_DIR = join(process.cwd(), 'config');

  async function fetchProviderModels(provider, apiConfig) {
    try {
      const headers = {};
      if (apiConfig.apiKey) headers['Authorization'] = `Bearer ${apiConfig.apiKey}`;
      const resp = await fetch(apiConfig.url, { headers, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return [];
      return await apiConfig.parser(resp);
    } catch (e) {
      console.warn(`[discovery] ${provider} API fetch failed:`, e.message);
      return [];
    }
  }

  const PROVIDER_APIS = {
    openrouter: {
      url: 'https://openrouter.ai/api/v1/models',
      parser: async (resp) => {
        const data = await resp.json();
        return (data.data || []).map((m) => ({
          id: m.id,
          name: m.name || m.id,
          context: m.context_length || null,
          free:
            m.id.endsWith(':free') || (m.pricing?.prompt === '0' && m.pricing?.completion === '0'),
          pricing: m.pricing
            ? { input: parseFloat(m.pricing.prompt), output: parseFloat(m.pricing.completion) }
            : null,
          description: m.description || null,
        }));
      },
    },
    groq: {
      url: 'https://api.groq.com/openai/v1/models',
      apiKey: config.litellm.providerKeys.groq,
      parser: async (resp) => {
        const data = await resp.json();
        return (data.data || []).map((m) => ({
          id: m.id,
          name: m.id,
          context: m.context_length || null,
          free: true,
          pricing: null,
        }));
      },
    },
    mistral: {
      url: 'https://api.mistral.ai/v1/models',
      apiKey: config.litellm.providerKeys.mistral,
      parser: async (resp) => {
        const data = await resp.json();
        return (data.data || []).map((m) => ({
          id: m.id,
          name: m.description || m.id,
          context: null,
          free: false,
          pricing: null,
          description: m.description || null,
          capabilities: m.capabilities || null,
        }));
      },
    },
    cerebras: {
      url: 'https://api.cerebras.ai/v1/models',
      apiKey: config.litellm.providerKeys.cerebras,
      parser: async (resp) => {
        const data = await resp.json();
        return (data.data || []).map((m) => ({
          id: m.id,
          name: m.id,
          context: null,
          free: true,
          pricing: null,
        }));
      },
    },
    nvidia: {
      url: 'https://integrate.api.nvidia.com/v1/models',
      parser: async (resp) => {
        const data = await resp.json();
        return (data.data || []).map((m) => ({
          id: m.id,
          name: m.id,
          context: null,
          free: true,
          pricing: null,
          description: null,
        }));
      },
    },
    ollama: {
      url: 'http://localhost:11434/api/tags',
      parser: async (resp) => {
        const data = await resp.json();
        return (data.models || []).map((m) => ({
          id: m.name,
          name: m.name,
          context: null,
          free: true,
          pricing: null,
          description: m.details?.parameter_size
            ? `${m.details.parameter_size} · ${m.details.quantization_level || 'unknown'} · ${m.details.family || ''}`
            : null,
        }));
      },
    },
  };

  const PROVIDER_LABEL_MAP = {
    openrouter: 'OpenRouter',
    groq: 'Groq',
    mistral: 'Mistral AI',
    cerebras: 'Cerebras',
    nvidia: 'NVIDIA NIM',
    opencode: 'OpenCode Zen',
    ollama: 'Ollama',
  };

  const PROVIDER_OPENAI_COMPAT = {
    openrouter: { api_base: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY' },
    nvidia: { api_base: 'https://integrate.api.nvidia.com/v1', api_key_env: 'NVIDIA_API_KEY' },
    opencode: { api_base: 'https://opencode.ai/zen/v1', api_key_env: 'OPENCODE_API_KEY' },
    ollama: { api_base: 'http://localhost:11434/v1', api_key_env: 'OLLAMA_API_KEY' },
  };

  const hasKey = (id) => !!config.litellm.providerKeys[id];

  function cleanModelName(str) {
    if (!str) return '';
    let name = str.split('/').pop().toLowerCase();
    name = name
      .replace(/[:-]free$/, '')
      .replace(/:\w+$/, '')
      .replace(/-instruct$/, '')
      .replace(/-chat$/, '')
      .replace(/-preview$/, '')
      .replace(/\b(202\d[-_]?\d{2}[-_]?\d{2})\b/g, '')
      .replace(/\(\s*\)/g, '')
      .replace(/\b(1106|0125|0513|0806|0613|0314)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
    return name;
  }

  async function fetchBenchmarks() {
    const arenaModels = [];
    try {
      const latestResp = await fetch(
        'https://raw.githubusercontent.com/oolong-tea-2026/arena-ai-leaderboards/main/data/latest.json',
        { signal: AbortSignal.timeout(10000) },
      );
      if (latestResp.ok) {
        const { path } = await latestResp.json();
        if (path) {
          const [textResp, codeResp] = await Promise.all([
            fetch(
              `https://raw.githubusercontent.com/oolong-tea-2026/arena-ai-leaderboards/main/data/${path}/text.json`,
              { signal: AbortSignal.timeout(10000) },
            ),
            fetch(
              `https://raw.githubusercontent.com/oolong-tea-2026/arena-ai-leaderboards/main/data/${path}/code.json`,
              { signal: AbortSignal.timeout(10000) },
            ),
          ]);

          const tempMap = {};
          if (textResp.ok) {
            const textData = await textResp.json();
            for (const m of textData.models || []) {
              const cleanName = cleanModelName(m.model);
              if (cleanName) {
                tempMap[cleanName] = {
                  cleanName,
                  intelligence_index: m.score ? Math.round(m.score) : null,
                  coding_index: null,
                  agentic_index: null,
                };
              }
            }
          }
          if (codeResp.ok) {
            const codeData = await codeResp.json();
            for (const m of codeData.models || []) {
              const cleanName = cleanModelName(m.model);
              if (cleanName) {
                if (!tempMap[cleanName])
                  tempMap[cleanName] = {
                    cleanName,
                    intelligence_index: null,
                    coding_index: null,
                    agentic_index: null,
                  };
                tempMap[cleanName].coding_index = m.score ? Math.round(m.score) : null;
              }
            }
          }
          arenaModels.push(...Object.values(tempMap));
        }
      }
    } catch (err) {
      console.warn('[discovery] Arena fetch failed:', err.message);
    }

    let benchmarkMap = {};
    let benchmarkByShortName = {};
    try {
      const orResp = await fetch('https://openrouter.ai/api/v1/models', {
        signal: AbortSignal.timeout(20000),
      });
      if (orResp.ok) {
        const orData = await orResp.json();
        for (const m of orData.data || []) {
          const aa = m.benchmarks?.artificial_analysis;
          if (aa) {
            benchmarkMap[m.id] = {
              intelligence_index: aa.intelligence_index ?? null,
              coding_index: aa.coding_index ?? null,
              agentic_index: aa.agentic_index ?? null,
            };
            const shortName = m.id.includes('/') ? m.id.split('/').slice(1).join('/') : m.id;
            if (shortName && !benchmarkByShortName[shortName])
              benchmarkByShortName[shortName] = benchmarkMap[m.id];
          }
        }
      }
    } catch (e) {}

    let aaModels = [];
    const aaApiKey =
      config.litellm.providerKeys.artificialAnalysis ||
      process.env.ARTIFICIAL_ANALYSIS_API_KEY ||
      'aa_yhfDRFqlUrBZnDPIGcMcnpaGWcFHPwUs';
    if (aaApiKey) {
      try {
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= 3) {
          const resp = await fetch(
            `https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`,
            {
              headers: { 'x-api-key': aaApiKey },
              signal: AbortSignal.timeout(15000),
            },
          );
          if (resp.ok) {
            const data = await resp.json();
            for (const m of data.data || []) {
              const evals = m.evaluations || {};
              const bm = {
                intelligence_index: evals.artificial_analysis_intelligence_index ?? null,
                coding_index: evals.artificial_analysis_coding_index ?? null,
                agentic_index: evals.artificial_analysis_agentic_index ?? null,
              };
              if (m.slug)
                aaModels.push({ slug: m.slug, cleanName: cleanModelName(m.slug), benchmarks: bm });
            }
            const pag = data.pagination || {};
            hasMore = pag.has_more === true;
            page = (pag.page || page) + 1;
          } else hasMore = false;
        }
      } catch (e) {
        console.warn('[discovery] AA fetch failed:', e.message);
      }
    }

    let lariMap = {};
    try {
      const lariResp = await fetch(
        'https://raw.githubusercontent.com/LARIkoz/ai-model-benchmarks/main/data/models.json',
        { signal: AbortSignal.timeout(15000) },
      );
      if (lariResp.ok) {
        const lariData = await lariResp.json();
        for (const m of lariData || []) {
          const oid = m.openrouter_id;
          if (!oid) continue;
          const s = m.scores || {};
          const numerics = (arr) => {
            const vals = arr
              .map((k) => {
                const v = s[k];
                return v && typeof v.value === 'number' ? v.value : null;
              })
              .filter((v) => v != null);
            return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
          };
          const intel = numerics(['gpqa', 'hle', 'arc_agi_2', 'aime_2025', 'mmlu_pro']);
          const code = numerics(['swe_v', 'swe_pro']);
          const agent = numerics(['tau2', 'terminal_bench_2', 'bfcl', 'browsecomp', 'gaia']);
          if (intel != null || code != null || agent != null)
            lariMap[oid] = { intelligence_index: intel, coding_index: code, agentic_index: agent };
        }
      }
    } catch (e) {}

    return { arenaModels, benchmarkMap, benchmarkByShortName, aaModels, lariMap };
  }

  function lookupBenchmark(modelId, fullId, providerId, benchmarkData) {
    const { arenaModels, benchmarkMap, benchmarkByShortName, aaModels, lariMap } = benchmarkData;
    const cleanId = cleanModelName(modelId);
    const aaSlug = modelId.includes('/') ? modelId.split('/').pop() : modelId;

    // 1. Arena (LMSYS)
    if (cleanId) {
      const arenaMatch = arenaModels.find(
        (m) => m.cleanName.includes(cleanId) || cleanId.includes(m.cleanName),
      );
      if (arenaMatch && (arenaMatch.intelligence_index != null || arenaMatch.coding_index != null))
        return {
          intelligence_index: arenaMatch.intelligence_index,
          coding_index: arenaMatch.coding_index,
          agentic_index: arenaMatch.agentic_index,
        };
    }

    // 2. AA precomputed
    const cached = aaModels.find((a) => a.slug === aaSlug || a.cleanName === cleanId);
    if (cached) return { ...cached.benchmarks };

    // 3. OpenRouter benchmarks
    if (benchmarkMap[fullId]) return { ...benchmarkMap[fullId] };
    if (benchmarkByShortName[modelId]) return { ...benchmarkByShortName[modelId] };

    // 4. LARIkoz
    if (lariMap[fullId]) return { ...lariMap[fullId] };
    if (lariMap[modelId]) return { ...lariMap[modelId] };

    return null;
  }

  router.get('/model-discovery', async (req, res, next) => {
    try {
      const benchmarkData = await fetchBenchmarks();
      const results = [];

      for (const [providerId, apiConfig] of Object.entries(PROVIDER_APIS)) {
        if (!hasKey(providerId)) continue;
        const models = await fetchProviderModels(providerId, apiConfig);
        const enriched = models
          .filter((m) => m.id)
          .map((m) => ({
            ...m,
            benchmarks: lookupBenchmark(m.id, `${providerId}/${m.id}`, providerId, benchmarkData),
          }))
          .sort((a, b) => (a.id || '').localeCompare(b.id || ''));

        results.push({
          provider: providerId,
          label: PROVIDER_LABEL_MAP[providerId] || providerId,
          model_prefix: `${providerId}/`,
          models: enriched,
        });
      }

      try {
        const zenRes = await fetch('https://opencode.ai/zen/v1/models', {
          signal: AbortSignal.timeout(10000),
        });
        if (zenRes.ok) {
          const zenData = await zenRes.json();
          const zenModels = (zenData?.data || [])
            .filter((m) => m.id)
            .map((m) => ({
              id: m.id,
              name: m.id,
              context: null,
              free: m.id.includes('free') || m.id === 'big-pickle',
              pricing: null,
              description: null,
              benchmarks: lookupBenchmark(m.id, `opencode/${m.id}`, 'opencode', benchmarkData),
            }))
            .sort((a, b) => (a.id || '').localeCompare(b.id || ''));
          results.push({
            provider: 'opencode',
            label: 'OpenCode Zen',
            model_prefix: 'opencode/',
            models: zenModels,
            error: null,
          });
        } else {
          results.push({
            provider: 'opencode',
            label: 'OpenCode Zen',
            model_prefix: 'opencode/',
            error: `HTTP ${zenRes.status}`,
            models: [],
          });
        }
      } catch (e) {
        results.push({
          provider: 'opencode',
          label: 'OpenCode Zen',
          model_prefix: 'opencode/',
          error: e.message,
          models: [],
        });
      }

      let configuredModels = [];
      try {
        const configPath = join(CONFIG_DIR, 'litellm.yaml');
        if (existsSync(configPath)) {
          const raw = readFileSync(configPath, 'utf8');
          const parsed = parse(raw);
          if (Array.isArray(parsed.model_list)) {
            configuredModels = parsed.model_list
              .map((e) => e?.litellm_params?.model)
              .filter(Boolean);
          }
        }
      } catch (e) {}

      res.json({ providers: results, configured_models: configuredModels });
    } catch (e) {
      next(e);
    }
  });

  router.post('/model-discovery/add', async (req, res, next) => {
    try {
      const { modelId, provider, modelName, apiKey, baseUrl, modelInfo } = req.body;
      if (!modelId || !provider) {
        return res.status(400).json({ success: false, error: 'modelId and provider are required' });
      }

      const modelNameFinal = modelName || modelId.split('/').pop() || modelId;
      const modelIdClean = modelId.startsWith(`${provider}/`)
        ? modelId.slice(provider.length + 1)
        : modelId;
      const compatConfig = PROVIDER_OPENAI_COMPAT[provider];
      const litellmModel = compatConfig ? `openai/${modelId}` : `${provider}/${modelIdClean}`;
      const litellmParams = {
        model: litellmModel,
        ...(compatConfig
          ? { api_base: compatConfig.api_base, api_key: `os.environ/${compatConfig.api_key_env}` }
          : {}),
        ...(apiKey ? { api_key: apiKey } : {}),
        ...(baseUrl ? { api_base: baseUrl } : {}),
      };
      const configPath = join(CONFIG_DIR, 'litellm.yaml');

      try {
        const raw = readFileSync(configPath, 'utf8');
        const parsed = parse(raw);
        if (!parsed.model_list) parsed.model_list = [];
        parsed.model_list.push({
          model_name: modelNameFinal,
          litellm_params: litellmParams,
          model_info: { ...(modelInfo || {}), provider },
        });
        writeFileSync(configPath, stringify(parsed), 'utf8');
      } catch (yamlErr) {
        return res
          .status(500)
          .json({ success: false, error: `YAML write failed: ${yamlErr.message}` });
      }

      const litellmKey = config.litellm.masterKey;
      try {
        const litellmRes = await fetch('http://127.0.0.1:4000/model/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${litellmKey}` },
          body: JSON.stringify({
            model_name: modelNameFinal,
            litellm_params: litellmParams,
            model_info: { ...(modelInfo || {}), provider },
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!litellmRes.ok) console.warn('[Discovery] liteLLM model new failed', litellmRes.status);
      } catch (e) {
        console.warn('[Discovery] liteLLM API unreachable', e.message);
      }

      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/model-discovery/remove', async (req, res, next) => {
    try {
      const { modelId, provider } = req.body;
      if (!modelId || !provider)
        return res.status(400).json({ success: false, error: 'modelId and provider are required' });
      const modelIdClean = modelId.startsWith(`${provider}/`)
        ? modelId.slice(provider.length + 1)
        : modelId;
      const fullModel = `${provider}/${modelIdClean}`;
      const configPath = join(CONFIG_DIR, 'litellm.yaml');

      const removedNames = [];

      try {
        const raw = readFileSync(configPath, 'utf8');
        const parsed = parse(raw);
        if (Array.isArray(parsed.model_list)) {
          const matches = parsed.model_list.filter(
            (entry) =>
              entry?.litellm_params?.model === fullModel ||
              entry?.litellm_params?.model === `${provider}/${modelId}`,
          );
          for (const m of matches) {
            if (m.model_name) removedNames.push(m.model_name);
          }

          parsed.model_list = parsed.model_list.filter(
            (entry) =>
              entry?.litellm_params?.model !== fullModel &&
              entry?.litellm_params?.model !== `${provider}/${modelId}`,
          );

          const cleanFallbacks = (fbs) => {
            if (!Array.isArray(fbs)) return fbs;
            return fbs
              .map((fb) => {
                if (fb && typeof fb === 'object') {
                  const updated = {};
                  for (const [key, val] of Object.entries(fb)) {
                    if (Array.isArray(val)) {
                      updated[key] = val.filter((a) => !removedNames.includes(a));
                    } else {
                      updated[key] = val;
                    }
                  }
                  return updated;
                }
                return fb;
              })
              .filter((fb) => {
                if (fb && typeof fb === 'object') {
                  return Object.values(fb).some((val) => Array.isArray(val) && val.length > 0);
                }
                return true;
              });
          };

          if (parsed.router_settings) {
            parsed.router_settings.fallbacks = cleanFallbacks(parsed.router_settings.fallbacks);
            parsed.router_settings.context_window_fallbacks = cleanFallbacks(
              parsed.router_settings.context_window_fallbacks,
            );
          }
        }
        writeFileSync(configPath, stringify(parsed), 'utf8');
      } catch (fileErr) {
        return res
          .status(500)
          .json({ success: false, error: `YAML update failed: ${fileErr.message}` });
      }

      try {
        const id = crypto.createHash('sha256').update(fullModel).digest('hex');
        const now = new Date().toISOString();
        collector
          .prepare(
            `INSERT INTO model_health (id, model_name, health_status, error_details, last_check, last_success, failure_streak)
             VALUES (?, ?, 'deprecated', 'Removed from config', ?, ?, 0)
             ON CONFLICT(id) DO UPDATE SET
               health_status = 'deprecated',
               error_details = 'Removed from config',
               last_check = excluded.last_check,
               last_success = excluded.last_success`,
          )
          .run(id, fullModel, now, now);
      } catch (e) {
        console.warn('[Discovery] failed to mark deprecated:', e.message);
      }

      const litellmKey = config.litellm.masterKey;
      try {
        const litellmRes = await fetch('http://127.0.0.1:4000/model/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${litellmKey}` },
          body: JSON.stringify({ model: fullModel }),
          signal: AbortSignal.timeout(10000),
        });
        if (!litellmRes.ok)
          console.warn('[Discovery] liteLLM model delete failed', litellmRes.status);
      } catch (e) {
        console.warn('[Discovery] liteLLM API unreachable', e.message);
      }

      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
