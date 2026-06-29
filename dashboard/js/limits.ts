// Model limits reference — LLM FREE / BYOK FALLBACK LIST
// Source: user reference 2026-05-30
// Format: modelId → { group, rpm, rpd, tpm, tpd, note }

export const MODEL_LIMITS = {
  // ── OpenCode Zen Free ──────────────────────────────────────────
  // Observed: ~200 req / 5-6h; no official RPM/RPD
  'big-pickle': {
    group: 'opencode',
    rpm: null,
    rph: 200,
    rphPeriod: 5,
    rpd: null,
    note: '200 req / 5h',
  },
  'deepseek-v4-flash': {
    group: 'opencode',
    rpm: null,
    rph: 200,
    rphPeriod: 5,
    rpd: null,
    note: '200 req / 5h',
  },
  'mimo-v2.5': {
    group: 'opencode',
    rpm: null,
    rph: 200,
    rphPeriod: 5,
    rpd: null,
    note: '200 req / 5h',
  },
  'north-mini-code-free': {
    group: 'opencode',
    rpm: null,
    rph: 200,
    rphPeriod: 5,
    rpd: null,
    note: '200 req / 5h',
  },
  'nemotron-3-ultra': {
    group: 'opencode',
    rpm: null,
    rph: 200,
    rphPeriod: 5,
    rpd: null,
    note: '200 req / 5h',
  },

  // ── OpenRouter Free (common: 20 RPM / 1000 RPD) ───────────────
  'openrouter/free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000, note: 'auto-router free' },
  'owl-alpha': { group: 'OpenRouter Free', rpm: 20, rpd: 1000 },
  'deepseek/deepseek-v4-flash:free': {
    group: 'OpenRouter Free',
    rpm: 20,
    rpd: 1000,
    note: 'coding/reasoning',
  },
  'qwen/qwen3-coder:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000, note: 'coding agent' },
  'nvidia/nemotron-3-ultra-550b-a55b:free': {
    group: 'OpenRouter Free',
    rpm: 20,
    rpd: 1000,
    note: 'planning',
  },
  'poolside/laguna-m.1:free': {
    group: 'OpenRouter Free',
    rpm: 20,
    rpd: 1000,
    note: 'coding agent',
  },
  'nex-agi/nex-n2-pro:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000, note: 'agentic' },
  'minimax/minimax-m2.5:free': {
    group: 'OpenRouter Free',
    rpm: 20,
    rpd: 1000,
    note: 'produttivit\u00e0',
  },
  'moonshotai/kimi-k2.6:free': {
    group: 'OpenRouter Free',
    rpm: 20,
    rpd: 1000,
    note: 'long context',
  },
  'openai/gpt-oss-120b:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000, note: 'reasoning' },
  'openai/gpt-oss-20b:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000 },
  'google/gemma-4-31b-it:free': {
    group: 'OpenRouter Free',
    rpm: 20,
    rpd: 1000,
    note: 'generalista',
  },
  'google/gemma-4-26b-a4b-it:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000 },
  'nvidia/nemotron-3-super-120b-a12b:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000 },
  'z-ai/glm-4.5-air:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000 },
  'nvidia/nemotron-3-nano-30b-a3b:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000 },
  'meta-llama/llama-3.3-70b-instruct:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000 },
  'poolside/laguna-xs.2:free': { group: 'OpenRouter Free', rpm: 20, rpd: 1000 },

  // ── Groq Free Plan (per-model limits) ─────────────────────────
  'qwen/qwen3-32b': { group: 'Groq Free', rpm: 60, rpd: 1000, tpm: 6000, tpd: 500000 },
  'meta-llama/llama-4-scout-17b-16e-instruct': {
    group: 'Groq Free',
    rpm: 30,
    rpd: 1000,
    tpm: 30000,
    tpd: 500000,
  },
  'llama-3.1-8b-instant': { group: 'Groq Free', rpm: 30, rpd: 14400, tpm: 6000, tpd: 500000 },
  'openai/gpt-oss-120b': { group: 'Groq Free', rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
  'openai/gpt-oss-20b': { group: 'Groq Free', rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
  'groq/compound': { group: 'Groq Free', rpm: 30, rpd: 250, tpm: 70000 },
  'groq/compound-mini': { group: 'Groq Free', rpm: 30, rpd: 250, tpm: 70000 },
  'allam-2-7b': { group: 'Groq Free', rpm: 30, rpd: 7000, tpm: 6000, tpd: 500000 },
  'llama-3.3-70b-versatile': { group: 'Groq Free', rpm: 30, rpd: 1000, tpm: 12000, tpd: 100000 },

  // Short keys for resolveLimit fallback (no provider prefix)
  'qwen3-32b': { group: 'Groq Free', rpm: 60, rpd: 1000, tpm: 6000 },
  compound: { group: 'Groq Free', rpm: 30, rpd: 250, tpm: 70000 },

  // ── Mistral BYOK (per-model RPM from account limits) ──────────
  // RPS → RPM conversion: RPS × 60
  'mistral-small-2506': { group: 'Mistral BYOK', rpm: 300, rpd: null, tpm: 2250000 },
  'ministral-3b-2512': { group: 'Mistral BYOK', rpm: 750, rpd: null, tpm: 1300000 },
  'labs-leanstral-2603': {
    group: 'Mistral BYOK',
    rpm: 38,
    rpd: null,
    tpm: 5000000,
    note: 'reasoning/Lean',
  },
  'open-mistral-nemo': { group: 'Mistral BYOK', rpm: 30, rpd: null, tpm: 937500 },
  'ministral-14b-2512': { group: 'Mistral BYOK', rpm: 30, rpd: null, tpm: 937500 },
  'codestral-2508': { group: 'Mistral BYOK', rpm: 125, rpd: null, tpm: 625000, note: 'coding' },
  'ministral-8b-2512': { group: 'Mistral BYOK', rpm: 188, rpd: null, tpm: 625000 },
  'mistral-large-2411': {
    group: 'Mistral BYOK',
    rpm: 26,
    rpd: null,
    tpm: 600000,
    tpmo: 200000000000,
  },
  'mistral-medium-2505': { group: 'Mistral BYOK', rpm: 25, rpd: null, tpm: 375000 },
  'mistral-medium-2508': { group: 'Mistral BYOK', rpm: 23, rpd: null, tpm: 356250 },
  'magistral-medium-2509': {
    group: 'Mistral BYOK',
    rpm: 5,
    rpd: null,
    tpm: 75000,
    note: 'reasoning',
  },
  'devstral-2512': {
    group: 'Mistral BYOK',
    rpm: 60,
    rpd: null,
    tpm: 50000,
    tpmo: 4000000,
    note: 'coding',
  },
  'devstral-medium-2507': {
    group: 'Mistral BYOK',
    rpm: 60,
    rpd: null,
    tpm: 50000,
    tpmo: 4000000,
    note: 'coding',
  },
  'mistral-small-2603': { group: 'Mistral BYOK', rpm: 50, rpd: null, tpm: 50000 },
  'pixtral-large-2411': {
    group: 'Mistral BYOK',
    rpm: 60,
    rpd: null,
    tpm: 50000,
    tpmo: 4000000,
    note: 'multimodal',
  },
  'magistral-small-2509': {
    group: 'Mistral BYOK',
    rpm: 2,
    rpd: null,
    tpm: 25000,
    tpmo: 1000000000,
    note: 'reasoning',
  },
  'mistral-large-2512': { group: 'Mistral BYOK', rpm: 60, rpd: null, tpm: 50000, tpmo: 4000000 },
  'mistral-medium-3-5': { group: 'Mistral BYOK', rpm: 60, rpd: null, tpm: 50000 },

  // ── Cerebras Free Trial ───────────────────────────────────────
  'gpt-oss-120b': { group: 'Cerebras', rpm: 5, rph: 150, rpd: 2400, tpm: 30000, tpd: 1000000 },
  'zai-glm-4.7': {
    group: 'Cerebras',
    rpm: 5,
    rph: 150,
    rpd: 2400,
    tpm: 30000,
    tpd: 1000000,
    note: 'preview',
  },

  // ── Kilo Free ─────────────────────────────────────────────────
  'kilo-auto/free': { group: 'Kilo', rpm: null, rph: 200, rpd: null, note: '200 req/h' },

  // ── Google AI Studio Free ─────────────────────────────────────
  'gemma-4-31b-it': { group: 'Google AI Studio', rpm: 15, rpd: 1500, note: 'quota buona' },
  'gemma-4-26b-a4b-it': { group: 'Google AI Studio', rpm: 15, rpd: 1500, note: 'quota buona' },
  'gemini-3.1-flash-lite': { group: 'Google AI Studio', rpm: 15, rpd: 500, tpm: 250000 },
  'gemini-2.5-flash-lite': { group: 'Google AI Studio', rpm: 10, rpd: 20, tpm: 250000 },
  'gemini-2.5-flash': { group: 'Google AI Studio', rpm: 5, rpd: 20, tpm: 250000 },
  'gemini-3.5-flash': { group: 'Google AI Studio', rpm: 5, rpd: 20, tpm: 250000 },
  'gemini-3-flash': { group: 'Google AI Studio', rpm: 5, rpd: 20, tpm: 250000 },

  // ── NVIDIA Build/NIM (opportunistic, ~40 RPM default) ────────
  'z-ai/glm-5.1': { group: 'NVIDIA Build', rpm: 40, rpd: null, note: 'agentic' },
  'deepseek-ai/deepseek-v4-pro': {
    group: 'NVIDIA Build',
    rpm: 40,
    rpd: null,
    note: 'coding/reasoning',
  },
  'deepseek-ai/deepseek-v4-flash': { group: 'NVIDIA Build', rpm: 40, rpd: null },
  'minimaxai/minimax-m2.7': {
    group: 'NVIDIA Build',
    rpm: 40,
    rpd: null,
    note: 'produttivit\u00e0',
  },

  // ── Modal ─────────────────────────────────────────────────────
  'zai-org/GLM-5.1-FP8': { group: 'Modal', rpm: null, rpd: null, note: '1 richiesta concorrente' },
  'zai-org/GLM-5-FP8': { group: 'Modal', rpm: null, rpd: null, note: '1 richiesta concorrente' },
};

export const PROVIDER_LABELS = {
  opencode: 'OpenCode',
  opencode_zen: 'OpenCode Zen',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  mistral: 'Mistral',
  kilo: 'Kilo',
  cerebras: 'Cerebras',
  nvidia: 'NVIDIA',
  modal: 'Modal',
  google: 'Google AI Studio',
  openai: 'OpenAI',
};

export function resolveLimit(provider, modelId) {
  if (modelId) {
    if (MODEL_LIMITS[modelId]) return MODEL_LIMITS[modelId];
    const last = modelId.split('/').pop();
    if (last && MODEL_LIMITS[last]) return MODEL_LIMITS[last];
  }
  if (provider === 'openai')
    return {
      group: 'opencode',
      rpm: null,
      rph: 200,
      rphPeriod: 5,
      rpd: null,
      note: '200 req / 5h',
    };
  if (provider === 'openrouter') return { group: 'OpenRouter Free', rpm: 20, rpd: 1000 };
  if (provider === 'groq') return { group: 'Groq Free', rpm: 30, rpd: 1000, tpm: 6000 };
  if (provider === 'mistral') return { group: 'Mistral BYOK', rpm: 60, rpd: null };
  if (provider === 'cerebras') return { group: 'Cerebras', rpm: 5, rph: 150, rpd: 2400 };
  if (provider === 'google') return { group: 'Google AI Studio', rpm: 15, rpd: 1500 };
  if (provider === 'kilo')
    return { group: 'Kilo', rpm: null, rph: 200, rpd: null, note: '200 req/h' };
  if (provider === 'modal')
    return { group: 'Modal', rpm: null, rpd: null, note: '1 rich. concorrente' };
  if (provider === 'nvidia') return { group: 'NVIDIA Build', rpm: 40, rpd: null };
  return null;
}
