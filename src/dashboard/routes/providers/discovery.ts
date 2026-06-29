import { Router, Request, Response, NextFunction } from 'express';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { parse, stringify } from 'yaml';
import config from '../../../config/index.js';
import { resolveUpstreamProvider } from './utils.js';
import type { MetricsCollector } from '../../collector.js';

interface DiscoveryDeps {
  collector?: MetricsCollector | null;
}

interface ProviderModel {
  id: string;
  name: string;
  context: number | null;
  free: boolean;
  pricing: { input: number; output: number } | null;
  description?: string | null;
  capabilities?: unknown | null;
}

interface EnrichedModel extends ProviderModel {
  quality_score: number | null;
  quality_source: string | null;
  context_source: string | null;
}

interface ProviderAPIConfig {
  url: string;
  apiKey?: string;
  parser: (resp: globalThis.Response) => Promise<ProviderModel[]>;
}

interface ArenaEntry {
  text_elo: number | null;
  code_elo: number | null;
  model: string;
}

interface BenchmarkData {
  arenaMap: Record<string, ArenaEntry>;
  orQualityMap: Record<string, number>;
  orByShort: Record<string, number>;
  orContextMap: Record<string, number>;
  lariQualityMap: Record<string, number>;
  lariContextMap: Record<string, number>;
  aaQualityMap: Record<string, number>;
  refContextOverrides: Record<string, number>;
}

interface QualityResult {
  quality_score: number;
  quality_source: string;
}

interface ContextResult {
  context: number | null;
  context_source: string | null;
}

interface ProviderResult {
  provider: string;
  label: string;
  model_prefix: string;
  models: EnrichedModel[];
  error?: string | null;
}

interface LitellmModelListEntry {
  model_name?: string;
  litellm_params?: {
    model?: string;
    api_base?: string;
    api_key?: string;
    rpm?: number;
    timeout?: number;
  };
  model_info?: {
    provider?: string;
    context_window?: number;
  };
}

interface RawORModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
  description?: string;
  benchmarks?: {
    artificial_analysis?: {
      intelligence_index?: number;
    };
    intelligence_index?: number;
  };
}

interface RawArenaModel {
  model: string;
  score: number;
}

interface RawAAModel {
  slug?: string;
  evaluations?: { artificial_analysis_intelligence_index?: number };
}

interface RawOllamaModel {
  name: string;
  description?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

interface LARIkozModel {
  openrouter_id?: string;
  context_length?: number;
  scores?: Record<string, { value: number } | undefined>;
}

interface RefModelEntry {
  model?: string;
  provider?: string;
  context?: number;
}

export function createDiscoveryRouter({ collector }: DiscoveryDeps) {
  const router = Router();
  const CONFIG_DIR = join(process.cwd(), 'config');

  const CACHE_TTL = process.env.NODE_ENV === 'test' ? 0 : 3600 * 1000;
  let cachedBenchmarks: BenchmarkData | null = null;
  let lastBenchmarksFetch = 0;
  const providerModelsCache = new Map<string, { data: ProviderModel[]; ts: number }>();

  async function fetchProviderModels(
    provider: string,
    apiConfig: ProviderAPIConfig,
  ): Promise<ProviderModel[]> {
    try {
      const headers: Record<string, string> = {};
      if (apiConfig.apiKey) headers['Authorization'] = `Bearer ${apiConfig.apiKey}`;
      const resp = await fetch(apiConfig.url, { headers, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return [];
      return await apiConfig.parser(resp);
    } catch (e) {
      console.warn(
        `[discovery] ${provider} API fetch failed:`,
        e instanceof Error ? e.message : String(e),
      );
      return [];
    }
  }

  async function fetchProviderModelsCached(
    provider: string,
    apiConfig: ProviderAPIConfig,
  ): Promise<ProviderModel[]> {
    const cached = providerModelsCache.get(provider);
    const now = Date.now();
    if (cached && now - cached.ts < CACHE_TTL) {
      return cached.data;
    }
    const data = await fetchProviderModels(provider, apiConfig);
    if (data && data.length > 0) {
      providerModelsCache.set(provider, { data, ts: now });
    }
    return data || (cached ? cached.data : []);
  }

  const PROVIDER_APIS: Record<string, ProviderAPIConfig> = {
    openrouter: {
      url: 'https://openrouter.ai/api/v1/models',
      parser: async (resp: globalThis.Response) => {
        const data = (await resp.json()) as { data?: RawORModel[] };
        return (data.data || []).map((m: RawORModel) => ({
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
      parser: async (resp: globalThis.Response) => {
        const data = (await resp.json()) as { data?: { id: string; context_length?: number }[] };
        return (data.data || []).map((m: { id: string; context_length?: number }) => ({
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
      parser: async (resp: globalThis.Response) => {
        const data = (await resp.json()) as {
          data?: {
            id: string;
            description?: string;
            max_context_length?: number;
            capabilities?: unknown;
          }[];
        };
        return (data.data || []).map(
          (m: {
            id: string;
            description?: string;
            max_context_length?: number;
            capabilities?: unknown;
          }) => ({
            id: m.id,
            name: m.description || m.id,
            context: m.max_context_length || null,
            free: false,
            pricing: null,
            description: m.description || null,
            capabilities: m.capabilities || null,
          }),
        );
      },
    },
    cerebras: {
      url: 'https://api.cerebras.ai/v1/models',
      apiKey: config.litellm.providerKeys.cerebras,
      parser: async (resp: globalThis.Response) => {
        const data = (await resp.json()) as { data?: { id: string }[] };
        return (data.data || []).map((m: { id: string }) => ({
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
      parser: async (resp: globalThis.Response) => {
        const data = (await resp.json()) as { data?: { id: string }[] };
        return (data.data || []).map((m: { id: string }) => ({
          id: m.id,
          name: m.id,
          context: null,
          free: true,
          pricing: null,
          description: null,
        }));
      },
    },
    kilo: {
      url: 'https://api.kilo.chat/v1/models',
      apiKey: config.litellm.providerKeys.kilo || config.litellm.providerKeys.kilocode,
      parser: async (resp: globalThis.Response) => {
        const data = (await resp.json()) as { data?: RawORModel[] };
        return (data.data || []).map((m: RawORModel) => ({
          id: m.id,
          name: m.id,
          context: m.context_length || null,
          free: m.id.includes('free') || m.id.endsWith(':free'),
          pricing: m.pricing
            ? { input: parseFloat(m.pricing.prompt), output: parseFloat(m.pricing.completion) }
            : null,
        }));
      },
    },
    ollama: {
      url: 'http://localhost:11434/api/tags',
      parser: async (resp: globalThis.Response) => {
        const data = (await resp.json()) as { models?: RawOllamaModel[] };
        return (data.models || []).map((m: RawOllamaModel) => ({
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

  const PROVIDER_LABEL_MAP: Record<string, string> = {
    openrouter: 'OpenRouter',
    groq: 'Groq',
    mistral: 'Mistral AI',
    cerebras: 'Cerebras',
    nvidia: 'NVIDIA NIM',
    opencode: 'OpenCode Zen',
    ollama: 'Ollama',
    kilo: 'Kilo Gateway',
  };

  const PROVIDER_OPENAI_COMPAT: Record<string, { api_base: string; api_key_env: string }> = {
    openrouter: { api_base: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY' },
    nvidia: { api_base: 'https://integrate.api.nvidia.com/v1', api_key_env: 'NVIDIA_API_KEY' },
    opencode: { api_base: 'https://opencode.ai/zen/v1', api_key_env: 'OPENCODE_API_KEY' },
    ollama: { api_base: 'http://localhost:11434/v1', api_key_env: 'OLLAMA_API_KEY' },
    kilo: { api_base: 'https://api.kilo.chat/v1', api_key_env: 'KILO_API_KEY' },
  };

  const hasKey = (id: string) => !!config.litellm.providerKeys[id];

  function cleanModelName(str: string): string {
    if (!str) return '';
    let name = (str.split('/').pop() || '').toLowerCase();
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

  // ── Normalize Arena ELO to 0-100 ──────────────────────────────────
  const normalizeElo = (score: number | null | undefined): number | null => {
    if (score == null) return null;
    // ELO range ~1000-1600 → 0-100
    const norm = Math.round(Math.max(0, Math.min(100, ((score - 1000) / 500) * 100)) * 10) / 10;
    return norm;
  };

  // ── Compute composite quality score from raw benchmark values ────
  function computeQualityFromScores(
    scores: Record<string, number | null | undefined>,
  ): number | null {
    // Weighted combination of individual benchmark scores
    const weights: Record<string, number> = {
      gpqa: 0.25, // PhD-level reasoning (0-100)
      swe_v: 0.25, // SWE-bench Verified coding (0-100)
      hle: 0.15, // Humanity's Last Exam (0-100)
      benchlm: 0.15, // BenchLM composite (0-100)
      lmarena: 0.2, // Arena ELO → normalized
    };
    let totalWeight = 0;
    let totalValue = 0;
    for (const [key, weight] of Object.entries(weights)) {
      let val = scores[key];
      if (val == null) continue;
      // Normalize Arena ELO (typically 1000-1600) to 0-100
      if (key === 'lmarena' && val > 100) {
        const normalized = normalizeElo(val);
        if (normalized != null) val = normalized;
      }
      totalWeight += weight;
      totalValue += val * weight;
    }
    if (totalWeight === 0) return null;
    return Math.round((totalValue / totalWeight) * 10) / 10;
  }

  // ── Fetch benchmark + context data from all free sources ─────────
  async function fetchBenchmarks(): Promise<BenchmarkData> {
    // === 1. Arena AI via Wulong REST API (free, no auth) ===
    const arenaMap: Record<string, ArenaEntry> = {};
    try {
      const [textResp, codeResp] = await Promise.all([
        fetch('https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text', {
          signal: AbortSignal.timeout(12000),
        }),
        fetch('https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code', {
          signal: AbortSignal.timeout(12000),
        }),
      ]);
      if (textResp.ok) {
        const textData = (await textResp.json()) as { models?: RawArenaModel[] };
        for (const m of textData.models || []) {
          const cn = cleanModelName(m.model);
          if (cn && m.score) {
            if (!arenaMap[cn]) arenaMap[cn] = { text_elo: null, code_elo: null, model: m.model };
            arenaMap[cn].text_elo = m.score;
          }
        }
      }
      if (codeResp.ok) {
        const codeData = (await codeResp.json()) as { models?: RawArenaModel[] };
        for (const m of codeData.models || []) {
          const cn = cleanModelName(m.model);
          if (cn && m.score) {
            if (!arenaMap[cn]) arenaMap[cn] = { text_elo: null, code_elo: null, model: m.model };
            arenaMap[cn].code_elo = m.score;
          }
        }
      }
    } catch (err) {
      console.warn(
        '[discovery] Arena (Wulong) fetch failed:',
        err instanceof Error ? err.message : String(err),
      );
    }

    // === 2. OpenRouter /api/v1/models (benchmarks + context) ===
    const orQualityMap: Record<string, number> = {};
    const orContextMap: Record<string, number> = {};
    const orByShort: Record<string, number> = {};
    try {
      const orResp = await fetch('https://openrouter.ai/api/v1/models', {
        signal: AbortSignal.timeout(20000),
      });
      if (orResp.ok) {
        const orData = (await orResp.json()) as { data?: RawORModel[] };
        for (const m of orData.data || []) {
          // Context map for all models
          if (m.context_length) orContextMap[m.id] = m.context_length;
          // Benchmark quality from artificial_analysis
          const aa = m.benchmarks?.artificial_analysis || m.benchmarks;
          const qi = aa?.intelligence_index;
          if (qi != null) {
            orQualityMap[m.id] = qi;
            const shortName = m.id.includes('/') ? m.id.split('/').slice(1).join('/') : m.id;
            if (shortName && !orByShort[shortName]) orByShort[shortName] = qi;
          }
        }
      }
    } catch (e) {
      console.warn(
        '[discovery] OpenRouter models fetch failed:',
        e instanceof Error ? e.message : String(e),
      );
    }

    // === 3. LARIkoz GitHub (rich benchmark data + context) ===
    const lariQualityMap: Record<string, number> = {};
    const lariContextMap: Record<string, number> = {};
    try {
      const lariResp = await fetch(
        'https://raw.githubusercontent.com/LARIkoz/ai-model-benchmarks/main/data/models.json',
        { signal: AbortSignal.timeout(15000) },
      );
      if (lariResp.ok) {
        const lariData = (await lariResp.json()) as LARIkozModel[] | { data?: LARIkozModel[] };
        const lariArr = Array.isArray(lariData) ? lariData : lariData.data || [];
        for (const m of lariArr) {
          const oid = m.openrouter_id;
          if (!oid) continue;
          // Context from LARIkoz
          if (m.context_length) lariContextMap[oid] = m.context_length;
          // Compute quality from raw scores
          const s = m.scores || {};
          const rawScores: Record<string, number> = {};
          for (const key of ['gpqa', 'swe_v', 'hle', 'benchlm', 'lmarena']) {
            const entry = s[key];
            if (entry && typeof entry.value === 'number') rawScores[key] = entry.value;
          }
          const quality = computeQualityFromScores(rawScores);
          if (quality != null) lariQualityMap[oid] = quality;
        }
      }
    } catch (e) {
      console.warn('[discovery] LARIkoz fetch failed:', e instanceof Error ? e.message : String(e));
    }

    // === 4. Artificial Analysis API (free tier) ===
    const aaQualityMap: Record<string, number> = {};
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
            const data = (await resp.json()) as {
              data?: RawAAModel[];
              pagination?: { has_more?: boolean; page?: number };
            };
            for (const m of data.data || []) {
              const evals = m.evaluations || {};
              const qi = evals.artificial_analysis_intelligence_index;
              if (qi != null && m.slug) {
                aaQualityMap[m.slug] = qi;
                aaQualityMap[cleanModelName(m.slug)] = qi;
              }
            }
            const pag = data.pagination || {};
            hasMore = pag.has_more === true;
            page = (pag.page || page) + 1;
          } else hasMore = false;
        }
      } catch (e) {
        console.warn('[discovery] AA fetch failed:', e instanceof Error ? e.message : String(e));
      }
    }

    // === 5. Load models-ref.json for provider-specific context overrides ===
    const refContextOverrides: Record<string, number> = {};
    try {
      const refPath = join(process.cwd(), 'dashboard', 'models-ref.json');
      if (existsSync(refPath)) {
        const refData = JSON.parse(readFileSync(refPath, 'utf8')) as RefModelEntry[];
        for (const entry of refData) {
          if (entry.context && entry.model && entry.provider) {
            const key = `${entry.provider}/${entry.model}`;
            refContextOverrides[key] = entry.context;
          }
        }
      }
    } catch (e) {
      console.warn(
        '[discovery] models-ref.json load failed:',
        e instanceof Error ? e.message : String(e),
      );
    }

    return {
      arenaMap,
      orQualityMap,
      orByShort,
      orContextMap,
      lariQualityMap,
      lariContextMap,
      aaQualityMap,
      refContextOverrides,
    };
  }

  async function fetchBenchmarksCached(): Promise<BenchmarkData> {
    const now = Date.now();
    if (cachedBenchmarks && now - lastBenchmarksFetch < CACHE_TTL) {
      return cachedBenchmarks;
    }
    try {
      const data = await fetchBenchmarks();
      cachedBenchmarks = data;
      lastBenchmarksFetch = now;
      return data;
    } catch (e) {
      console.warn(
        '[discovery] fetchBenchmarks failed, using cache:',
        e instanceof Error ? e.message : String(e),
      );
      return (
        cachedBenchmarks ||
        ({
          arenaMap: {},
          orQualityMap: {},
          orByShort: {},
          orContextMap: {},
          lariQualityMap: {},
          lariContextMap: {},
          aaQualityMap: {},
          refContextOverrides: {},
        } as BenchmarkData)
      );
    }
  }

  // ── Lookup unified quality score (0-100) for a model ─────────────
  function lookupQuality(
    modelId: string,
    fullId: string,
    providerId: string,
    benchmarkData: BenchmarkData,
  ): QualityResult | null {
    const { arenaMap, orQualityMap, orByShort, lariQualityMap, aaQualityMap } = benchmarkData;
    const cleanId = cleanModelName(modelId);
    const slug: string = modelId.includes('/') ? modelId.split('/').pop() || '' : modelId;

    // 1. OpenRouter benchmarks (most reliable, already 0-100)
    if (orQualityMap[fullId])
      return { quality_score: orQualityMap[fullId], quality_source: 'openrouter' };
    if (orQualityMap[modelId])
      return { quality_score: orQualityMap[modelId], quality_source: 'openrouter' };
    if (orByShort[modelId])
      return { quality_score: orByShort[modelId], quality_source: 'openrouter' };
    if (orByShort[slug]) return { quality_score: orByShort[slug], quality_source: 'openrouter' };

    // 2. LARIkoz composite (rich benchmark data, computed)
    if (lariQualityMap[fullId])
      return { quality_score: lariQualityMap[fullId], quality_source: 'larikoz' };
    if (lariQualityMap[modelId])
      return { quality_score: lariQualityMap[modelId], quality_source: 'larikoz' };

    // 3. Arena AI ELO → normalized (text + code average)
    if (cleanId && arenaMap[cleanId]) {
      const arena = arenaMap[cleanId];
      const textNorm = arena.text_elo ? normalizeElo(arena.text_elo) : null;
      const codeNorm = arena.code_elo ? normalizeElo(arena.code_elo) : null;
      const vals = [textNorm, codeNorm].filter((v) => v != null);
      if (vals.length > 0) {
        const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
        return { quality_score: avg, quality_source: 'arena' };
      }
    }

    // 4. Artificial Analysis (fallback)
    if (aaQualityMap[slug]) return { quality_score: aaQualityMap[slug], quality_source: 'aa' };
    if (cleanId && aaQualityMap[cleanId])
      return { quality_score: aaQualityMap[cleanId], quality_source: 'aa' };

    return null;
  }

  // ── Resolve context window with provider-specific priority ───────
  function resolveContext(
    modelId: string,
    providerContext: number | null,
    providerId: string,
    benchmarkData: BenchmarkData,
  ): ContextResult {
    const { refContextOverrides, orContextMap, lariContextMap } = benchmarkData;

    // 1. Provider API returned a value — use it
    if (providerContext) return { context: providerContext, context_source: 'provider' };

    // 2. models-ref.json override (provider-specific caps)
    const refKey = `${providerId}/${modelId}`;
    if (refContextOverrides[refKey])
      return { context: refContextOverrides[refKey], context_source: 'override' };

    // 3. LARIkoz context_length (model's generic context)
    const slug: string = modelId.includes('/') ? modelId.split('/').pop() || '' : modelId;
    for (const [oid, ctx] of Object.entries(lariContextMap)) {
      const lariSlug: string = oid.includes('/') ? oid.split('/').pop() || '' : oid;
      const cleanOid = cleanModelName(oid);
      const cleanMid = cleanModelName(modelId);
      if (lariSlug === slug || lariSlug === modelId || cleanOid === cleanMid) {
        return { context: ctx, context_source: 'larikoz' };
      }
    }

    // 4. OpenRouter context (model's generic context)
    for (const [orId, ctx] of Object.entries(orContextMap)) {
      const orSlug: string = orId.includes('/') ? orId.split('/').pop() || '' : orId;
      const cleanOr = cleanModelName(orId);
      const cleanMid = cleanModelName(modelId);
      if (orSlug === slug || orSlug === modelId || cleanOr === cleanMid) {
        return { context: ctx, context_source: 'openrouter' };
      }
    }

    return { context: null, context_source: null };
  }

  router.get('/model-discovery', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const benchmarkData = await fetchBenchmarksCached();
      const results: ProviderResult[] = [];

      for (const [providerId, apiConfig] of Object.entries(PROVIDER_APIS)) {
        if (!hasKey(providerId)) continue;
        const models = await fetchProviderModelsCached(providerId, apiConfig);
        const enriched = models
          .filter((m: ProviderModel) => m.id)
          .map((m: ProviderModel) => {
            const quality = lookupQuality(m.id, `${providerId}/${m.id}`, providerId, benchmarkData);
            const resolved = resolveContext(m.id, m.context, providerId, benchmarkData);
            return {
              ...m,
              quality_score: quality?.quality_score ?? null,
              quality_source: quality?.quality_source ?? null,
              context: resolved.context,
              context_source: resolved.context_source,
            };
          })
          .sort((a: EnrichedModel, b: EnrichedModel) => (a.id || '').localeCompare(b.id || ''));

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
          const zenData = (await zenRes.json()) as { data?: { id: string }[] };
          const zenModels = (zenData?.data || [])
            .filter((m: { id: string }) => m.id)
            .map((m: { id: string }) => {
              const quality = lookupQuality(m.id, `opencode/${m.id}`, 'opencode', benchmarkData);
              const resolved = resolveContext(m.id, null, 'opencode', benchmarkData);
              return {
                id: m.id,
                name: m.id,
                context: resolved.context,
                context_source: resolved.context_source,
                free: m.id.includes('free') || m.id === 'big-pickle',
                pricing: null,
                description: null,
                quality_score: quality?.quality_score ?? null,
                quality_source: quality?.quality_source ?? null,
              };
            })
            .sort((a: EnrichedModel, b: EnrichedModel) => (a.id || '').localeCompare(b.id || ''));
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
          error: e instanceof Error ? e.message : String(e),
          models: [],
        });
      }

      const configuredModels: string[] = [];
      try {
        const configPath = join(CONFIG_DIR, 'litellm.yaml');
        if (existsSync(configPath)) {
          const raw = readFileSync(configPath, 'utf8');
          const parsed = parse(raw) as { model_list?: LitellmModelListEntry[] };
          if (Array.isArray(parsed.model_list)) {
            for (const e of parsed.model_list) {
              const model = e?.litellm_params?.model;
              if (model) {
                configuredModels.push(model);
                const provider =
                  e?.model_info?.provider || resolveUpstreamProvider(model, 'unknown');
                if (provider && provider !== 'unknown') {
                  if (model.startsWith('openai/')) {
                    configuredModels.push(model.replace('openai/', `${provider}/`));
                    configuredModels.push(model.replace('openai/', ''));
                  }
                }
                if (model.startsWith('openrouter/openrouter/')) {
                  configuredModels.push(model.replace('openrouter/openrouter/', 'openrouter/'));
                }
              }
            }
          }
        }
      } catch (e) {
        // Ignore parse errors — the configured models list is best-effort
      }

      res.json({ providers: results, configured_models: configuredModels });
    } catch (e) {
      next(e);
    }
  });

  router.post('/model-discovery/add', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { modelId, provider, modelName, apiKey, baseUrl, modelInfo } = req.body;
      if (!modelId || !provider) {
        return res.status(400).json({ success: false, error: 'modelId and provider are required' });
      }

      const modelNameFinal = modelName || modelId.split('/').pop() || modelId;
      const modelIdClean = modelId.startsWith(`${provider}/`)
        ? modelId.slice(provider.length + 1)
        : modelId;
      const compatConfig = PROVIDER_OPENAI_COMPAT[provider as string];
      const litellmModel = compatConfig ? `openai/${modelId}` : `${provider}/${modelIdClean}`;
      const litellmParams: Record<string, unknown> = {
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
        const parsed = parse(raw) as { model_list?: LitellmModelListEntry[] };
        if (!parsed.model_list) parsed.model_list = [];
        parsed.model_list.push({
          model_name: modelNameFinal,
          litellm_params: litellmParams as LitellmModelListEntry['litellm_params'],
          model_info: { ...(modelInfo || {}), provider },
        });
        writeFileSync(configPath, stringify(parsed), 'utf8');
      } catch (yamlErr) {
        return res.status(500).json({
          success: false,
          error: `YAML write failed: ${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}`,
        });
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
        console.warn(
          '[Discovery] liteLLM API unreachable',
          e instanceof Error ? e.message : String(e),
        );
      }

      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });

  router.post(
    '/model-discovery/remove',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { modelId, provider } = req.body;
        if (!modelId || !provider)
          return res
            .status(400)
            .json({ success: false, error: 'modelId and provider are required' });
        const modelIdClean = modelId.startsWith(`${provider}/`)
          ? modelId.slice(provider.length + 1)
          : modelId;
        const fullModel = `${provider}/${modelIdClean}`;
        const configPath = join(CONFIG_DIR, 'litellm.yaml');

        const compatConfig = PROVIDER_OPENAI_COMPAT[provider as string];
        const litellmModel = compatConfig ? `openai/${modelId}` : `${provider}/${modelIdClean}`;

        const removedNames: string[] = [];

        try {
          const raw = readFileSync(configPath, 'utf8');
          const parsed = parse(raw) as {
            model_list?: LitellmModelListEntry[];
            router_settings?: { fallbacks?: unknown[]; context_window_fallbacks?: unknown[] };
          };
          if (Array.isArray(parsed.model_list)) {
            const matches = parsed.model_list.filter(
              (entry: LitellmModelListEntry) =>
                (entry?.litellm_params?.model === litellmModel ||
                  entry?.litellm_params?.model === fullModel ||
                  entry?.litellm_params?.model === `${provider}/${modelId}`) &&
                !entry?.model_name?.startsWith('openai/tier-'),
            );
            for (const m of matches) {
              if (m.model_name) removedNames.push(m.model_name);
            }

            parsed.model_list = parsed.model_list.filter(
              (entry) =>
                entry?.model_name?.startsWith('openai/tier-') ||
                (entry?.litellm_params?.model !== litellmModel &&
                  entry?.litellm_params?.model !== fullModel &&
                  entry?.litellm_params?.model !== `${provider}/${modelId}`),
            );

            const cleanFallbacks = (fbs: unknown[]): Record<string, unknown>[] => {
              if (!Array.isArray(fbs)) return [];
              return fbs
                .map((fb: unknown) => {
                  if (typeof fb === 'string') {
                    return { model: fb };
                  } else if (typeof fb === 'object' && fb !== null) {
                    const updated: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(fb)) {
                      updated[k] = k === 'fallbacks' ? cleanFallbacks(v as unknown[]) : v;
                    }
                    return updated;
                  }
                  return {};
                })
                .filter((fb: Record<string, unknown>) => {
                  return Object.values(fb).some(
                    (val: unknown) =>
                      (typeof val === 'string' && val.trim().length > 0) ||
                      (Array.isArray(val) && val.length > 0),
                  );
                });
            };

            if (parsed.router_settings) {
              parsed.router_settings.fallbacks = cleanFallbacks(
                parsed.router_settings.fallbacks || [],
              );
              parsed.router_settings.context_window_fallbacks = cleanFallbacks(
                parsed.router_settings.context_window_fallbacks || [],
              );
            }
          }
          writeFileSync(configPath, stringify(parsed), 'utf8');
        } catch (fileErr) {
          return res.status(500).json({
            success: false,
            error: `YAML update failed: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`,
          });
        }

        if (collector) {
          try {
            const id = crypto.createHash('sha256').update(fullModel).digest('hex');
            const now = new Date().toISOString();
            collector.db
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
            console.warn(
              '[Discovery] failed to mark deprecated:',
              e instanceof Error ? e.message : String(e),
            );
          }
        }

        const litellmKey = config.litellm.masterKey;
        const targetAlias = removedNames[0] || modelId.split('/').pop() || modelId;
        try {
          const litellmRes = await fetch('http://127.0.0.1:4000/model/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${litellmKey}` },
            body: JSON.stringify({
              id: targetAlias,
              model: litellmModel,
              model_name: targetAlias,
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!litellmRes.ok)
            console.warn('[Discovery] liteLLM model delete failed', litellmRes.status);
        } catch (e) {
          console.warn(
            '[Discovery] liteLLM API unreachable',
            e instanceof Error ? e.message : String(e),
          );
        }

        res.json({ success: true });
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
