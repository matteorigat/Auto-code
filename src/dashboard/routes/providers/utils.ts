import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import crypto from 'node:crypto';
import config from '../../../config/index.js';
import type { MetricsCollector } from '../../collector.js';

interface YamlModelEntry {
  model_name?: string;
  litellm_params?: {
    model?: string;
    rpm?: number;
    timeout?: number;
    api_base?: string;
  };
  model_info?: {
    provider?: string;
    context_window?: number;
  };
}

interface UniqueModelEntry {
  actual_model: string;
  provider: string;
  aliases: string[];
}

interface ModelHealthRow {
  health_status?: string;
  error_details?: string | null;
  last_check?: string | null;
  last_success?: string | null;
  failure_streak?: number;
  model_name?: string;
}

export interface ModelResult {
  id: string;
  actual_model: string;
  provider: string;
  aliases: string[];
  health_status: string;
  error_details: string | null;
  last_check: string | null;
  last_success: string | null;
  failure_streak: number;
}

export function resolveUpstreamProvider(actualModel: string, defaultProvider = 'unknown'): string {
  const modelLower = actualModel.toLowerCase();

  if (modelLower.startsWith('opencode/')) return 'opencode';
  if (modelLower.startsWith('openrouter/')) return 'openrouter';
  if (modelLower.startsWith('groq/')) return 'groq';
  if (
    modelLower.startsWith('mistral/') ||
    modelLower.startsWith('codestral/') ||
    modelLower.startsWith('ministral/')
  )
    return 'mistral';
  if (modelLower.startsWith('nvidia/') || modelLower.startsWith('nvidia_nim/')) return 'nvidia';
  if (modelLower.startsWith('kilo/') || modelLower.startsWith('kilocode/')) return 'kilo';
  if (modelLower.startsWith('cerebras/')) return 'cerebras';
  if (modelLower.startsWith('ollama/')) return 'ollama';

  if (
    modelLower.includes('big-pickle') ||
    modelLower.includes('north-mini-code-free') ||
    modelLower.includes('mimo-v2.5')
  ) {
    return 'opencode';
  }

  if (modelLower.includes('nemotron-3-ultra')) {
    return 'opencode';
  }

  try {
    const configPath = join(process.cwd(), 'config', 'litellm.yaml');
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = parse(raw) as { model_list?: YamlModelEntry[] };
      const models = parsed.model_list || [];

      for (const m of models) {
        const yamlModel = (m.litellm_params?.model || '').toLowerCase();
        const yamlAlias = (m.model_name || '').toLowerCase();
        const yamlProvider = m.model_info?.provider || '';
        if (yamlModel === modelLower || yamlAlias === modelLower) {
          if (yamlProvider) {
            return yamlProvider === 'opencode_zen' ? 'opencode' : yamlProvider;
          }
        }
      }

      const parts = modelLower.split('/');
      const baseName = parts[parts.length - 1];
      if (baseName && baseName.length > 3) {
        for (const m of models) {
          const yamlModel = (m.litellm_params?.model || '').toLowerCase();
          const yamlAlias = (m.model_name || '').toLowerCase();
          const yamlProvider = m.model_info?.provider || '';
          const yamlBase = yamlModel.split('/').pop();
          const yamlAliasBase = yamlAlias.split('/').pop();
          if (yamlBase === baseName || yamlAliasBase === baseName) {
            if (yamlProvider) {
              return yamlProvider === 'opencode_zen' ? 'opencode' : yamlProvider;
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn(
      '[providers] resolveUpstreamProvider yaml parse failed:',
      e instanceof Error ? e.message : String(e),
    );
  }

  if (modelLower.includes('openrouter')) return 'openrouter';
  if (modelLower.includes('groq')) return 'groq';
  if (
    modelLower.includes('mistral') ||
    modelLower.includes('codestral') ||
    modelLower.includes('ministral')
  )
    return 'mistral';
  if (modelLower.includes('nvidia') || modelLower.includes('nim')) return 'nvidia';
  if (modelLower.includes('opencode') || modelLower.includes('zen')) return 'opencode';
  if (modelLower.includes('kilo')) return 'kilo';
  if (modelLower.includes('cerebras')) return 'cerebras';
  if (modelLower.includes('ollama')) return 'ollama';

  if (defaultProvider === 'opencode_zen') return 'opencode';
  if (defaultProvider === 'openai') return 'opencode';

  return defaultProvider === 'opencode_zen' ? 'opencode' : defaultProvider;
}

export function getModelsFromYaml(): YamlModelEntry[] {
  const configPath = join(process.cwd(), 'config', 'litellm.yaml');
  if (!existsSync(configPath)) {
    return [];
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = parse(raw) as { model_list?: YamlModelEntry[] };
  return parsed.model_list || [];
}

export function formatDateTime(date: string | number | Date): string | null {
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function runModelHealthProbe(
  modelName: string,
): Promise<{ status: string; errorDetails: string }> {
  try {
    const litellmKey = config.litellm.masterKey;
    const res = await fetch('http://127.0.0.1:4000/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${litellmKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (res.ok) {
      return { status: 'healthy', errorDetails: 'No errors' };
    } else {
      let errMsg = `HTTP ${res.status}`;
      try {
        const json = (await res.json()) as { error?: { message?: string } | string };
        if (json.error && typeof json.error === 'object' && json.error.message) {
          errMsg = json.error.message;
        } else if (json.error) {
          errMsg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        }
      } catch {
        // Ignore invalid JSON format from LiteLLM proxy
      }
      return { status: 'unhealthy', errorDetails: errMsg };
    }
  } catch (err) {
    const error = err as Error;
    let errMsg = error.message || String(err);
    if (error.name === 'TimeoutError' || errMsg.includes('timeout')) {
      errMsg = 'TimeoutError: 408';
    } else if (errMsg.includes('ECONNREFUSED')) {
      errMsg = 'ConnectionRefusedError: LiteLLM proxy not running';
    }
    return { status: 'unhealthy', errorDetails: errMsg };
  }
}

export function getUniqueModels(collector: MetricsCollector): ModelResult[] {
  const yamlModels = getModelsFromYaml();
  const uniqueMap = new Map<string, UniqueModelEntry>();

  for (const m of yamlModels) {
    if (!m.model_name) continue;

    let actualModel = m.litellm_params?.model || m.model_name;
    let provider = m.model_info?.provider || 'unknown';
    if (provider === 'opencode_zen') provider = 'opencode';

    provider = resolveUpstreamProvider(actualModel, provider);

    if (actualModel.startsWith('openai/')) {
      actualModel = actualModel.replace('openai/', `${provider}/`);
    }
    if (actualModel.startsWith('openrouter/openrouter/')) {
      actualModel = actualModel.replace('openrouter/openrouter/', 'openrouter/');
    }

    if (!uniqueMap.has(actualModel)) {
      uniqueMap.set(actualModel, {
        actual_model: actualModel,
        provider,
        aliases: [],
      });
    }

    const entry = uniqueMap.get(actualModel)!;
    if (!entry.aliases.includes(m.model_name)) {
      entry.aliases.push(m.model_name);
    }
  }

  const dbRows = collector.query('SELECT * FROM model_health') as ModelHealthRow[];
  for (const r of dbRows) {
    const dbModelName = String(r.model_name || '');
    if (!dbModelName) continue;

    let normalizedModel = dbModelName;
    let provider = 'unknown';
    if (dbModelName.includes('/')) {
      provider = dbModelName.split('/')[0];
    }
    if (provider === 'opencode_zen') provider = 'opencode';

    provider = resolveUpstreamProvider(normalizedModel, provider);

    if (normalizedModel.startsWith('openai/')) {
      normalizedModel = normalizedModel.replace('openai/', `${provider}/`);
    }
    if (normalizedModel.startsWith('openrouter/openrouter/')) {
      normalizedModel = normalizedModel.replace('openrouter/openrouter/', 'openrouter/');
    }

    let isAlias = false;
    for (const entry of uniqueMap.values()) {
      if (entry.aliases.includes(dbModelName) || entry.aliases.includes(normalizedModel)) {
        isAlias = true;
        break;
      }
    }

    if (isAlias || !uniqueMap.has(normalizedModel)) {
      if (r.health_status !== 'deprecated') continue;
      uniqueMap.set(normalizedModel, {
        actual_model: normalizedModel,
        provider,
        aliases: [],
      });
    }
  }

  const results: ModelResult[] = [];
  for (const [actualModel, entry] of uniqueMap.entries()) {
    const id = crypto.createHash('sha256').update(actualModel).digest('hex');
    let dbRow = collector.get('SELECT * FROM model_health WHERE id = ?', [id]) as
      | ModelHealthRow
      | undefined;

    if (!dbRow && entry.aliases.length > 0) {
      for (const alias of entry.aliases) {
        const aliasId = crypto.createHash('sha256').update(alias).digest('hex');
        const aliasRow = collector.get('SELECT * FROM model_health WHERE id = ?', [aliasId]) as
          | ModelHealthRow
          | undefined;
        if (aliasRow) {
          dbRow = aliasRow;
          break;
        }
      }
    }

    const healthRow = dbRow || ({} as ModelHealthRow);

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
