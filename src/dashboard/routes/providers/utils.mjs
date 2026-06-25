import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import crypto from 'node:crypto';
import config from '../../../config/index.mjs';

export function resolveUpstreamProvider(actualModel, defaultProvider = 'unknown') {
  const modelLower = actualModel.toLowerCase();

  if (
    modelLower.startsWith('opencode/') ||
    modelLower.includes('big-pickle') ||
    modelLower.includes('nemotron-3-ultra') ||
    modelLower.includes('mimo-v2.5') ||
    modelLower.includes('north-mini-code-free')
  ) {
    return 'opencode';
  }

  try {
    const configPath = join(process.cwd(), 'config', 'litellm.yaml');
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = parse(raw);
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
          const yamlProvider = m.model_info?.provider || '';
          if (yamlModel.includes(baseName)) {
            if (yamlProvider) {
              return yamlProvider === 'opencode_zen' ? 'opencode' : yamlProvider;
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('[providers] resolveUpstreamProvider yaml parse failed:', e.message);
  }

  if (modelLower.startsWith('openrouter/')) return 'openrouter';
  if (modelLower.startsWith('groq/')) return 'groq';
  if (
    modelLower.startsWith('mistral/') ||
    modelLower.startsWith('codestral/') ||
    modelLower.startsWith('ministral/')
  )
    return 'mistral';
  if (modelLower.startsWith('nvidia/')) return 'nvidia';
  if (modelLower.startsWith('opencode/')) return 'opencode';

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

  if (defaultProvider === 'opencode_zen') return 'opencode';
  if (defaultProvider === 'openai') {
    return 'opencode';
  }

  return defaultProvider === 'opencode_zen' ? 'opencode' : defaultProvider;
}

export function getModelsFromYaml() {
  const configPath = join(process.cwd(), 'config', 'litellm.yaml');
  if (!existsSync(configPath)) {
    return [];
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = parse(raw);
  return parsed.model_list || [];
}

export function formatDateTime(date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function runModelHealthProbe(modelName) {
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
        const json = await res.json();
        if (json.error?.message) {
          errMsg = json.error.message;
        } else if (json.error) {
          errMsg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        }
      } catch (_) {}
      return { status: 'unhealthy', errorDetails: errMsg };
    }
  } catch (err) {
    let errMsg = err.message || String(err);
    if (err.name === 'TimeoutError' || errMsg.includes('timeout')) {
      errMsg = 'TimeoutError: 408';
    } else if (errMsg.includes('ECONNREFUSED')) {
      errMsg = 'ConnectionRefusedError: LiteLLM proxy not running';
    }
    return { status: 'unhealthy', errorDetails: errMsg };
  }
}

export function getUniqueModels(collector) {
  const yamlModels = getModelsFromYaml();
  const uniqueMap = new Map();

  for (const m of yamlModels) {
    if (!m.model_name) continue;

    let actualModel = m.litellm_params?.model || m.model_name;
    if (actualModel.startsWith('openrouter/openrouter/')) {
      actualModel = actualModel.replace('openrouter/openrouter/', 'openrouter/');
    }
    let provider = m.model_info?.provider || 'unknown';

    if (provider === 'opencode_zen' || provider === 'opencode') {
      provider = 'opencode';
      if (actualModel.startsWith('openai/')) {
        actualModel = actualModel.replace('openai/', 'opencode/');
      }
    } else {
      provider = resolveUpstreamProvider(actualModel, provider);
    }

    if (!uniqueMap.has(actualModel)) {
      uniqueMap.set(actualModel, {
        actual_model: actualModel,
        provider: provider,
        aliases: [],
      });
    }

    const entry = uniqueMap.get(actualModel);
    if (!entry.aliases.includes(m.model_name)) {
      entry.aliases.push(m.model_name);
    }
  }

  const dbRows = collector.query('SELECT * FROM model_health');
  for (const r of dbRows) {
    const dbModelName = r.model_name;

    let normalizedModel = dbModelName;
    if (normalizedModel.startsWith('openrouter/openrouter/')) {
      normalizedModel = normalizedModel.replace('openrouter/openrouter/', 'openrouter/');
    }
    let provider = 'unknown';
    if (dbModelName.includes('/')) {
      provider = dbModelName.split('/')[0];
    }
    if (provider === 'opencode_zen' || provider === 'opencode' || provider === 'openai') {
      if (
        normalizedModel.startsWith('openai/') &&
        (normalizedModel.includes('big-pickle') ||
          normalizedModel.includes('nemotron-3-ultra') ||
          normalizedModel.includes('deepseek-v4-flash') ||
          normalizedModel.includes('mimo-v2.5') ||
          normalizedModel.includes('north-mini-code-free'))
      ) {
        normalizedModel = normalizedModel.replace('openai/', 'opencode/');
        provider = 'opencode';
      } else if (normalizedModel.startsWith('opencode/')) {
        provider = 'opencode';
      }
    }

    provider = resolveUpstreamProvider(normalizedModel, provider);

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
        provider: provider,
        aliases: [],
      });
      continue;
    }
  }

  const results = [];
  for (const [actualModel, entry] of uniqueMap.entries()) {
    const id = crypto.createHash('sha256').update(actualModel).digest('hex');
    let dbRow = collector.get('SELECT * FROM model_health WHERE id = ?', [id]);

    if (!dbRow && entry.aliases.length > 0) {
      for (const alias of entry.aliases) {
        const aliasId = crypto.createHash('sha256').update(alias).digest('hex');
        const aliasRow = collector.get('SELECT * FROM model_health WHERE id = ?', [aliasId]);
        if (aliasRow) {
          dbRow = aliasRow;
          break;
        }
      }
    }

    if (!dbRow) {
      dbRow = {
        health_status: 'unchecked',
        error_details: null,
        last_check: null,
        last_success: null,
      };
    }

    results.push({
      id: id,
      actual_model: actualModel,
      provider: entry.provider,
      aliases: entry.aliases,
      health_status: dbRow.health_status,
      error_details: dbRow.error_details === 'None' ? null : dbRow.error_details,
      last_check: dbRow.last_check === 'None' ? null : dbRow.last_check,
      last_success: dbRow.last_success === 'None' ? null : dbRow.last_success,
      failure_streak: dbRow.failure_streak || 0,
    });
  }

  return results;
}
