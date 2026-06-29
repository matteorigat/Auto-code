import crypto from 'node:crypto';
import config from '../../../config/index.js';
import type { MetricsCollector } from '../../collector.js';

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

export function formatDateTime(date: string | number | Date): string | null {
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function runModelHealthProbe(
  modelName: string,
): Promise<{ status: string; errorDetails: string }> {
  try {
    const apiKey = config.omniroute.apiKey;
    const res = await fetch(`${config.omniroute.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
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
        // Ignore invalid JSON format
      }
      return { status: 'unhealthy', errorDetails: errMsg };
    }
  } catch (err) {
    const error = err as Error;
    let errMsg = error.message || String(err);
    if (error.name === 'TimeoutError' || errMsg.includes('timeout')) {
      errMsg = 'TimeoutError: 408';
    } else if (errMsg.includes('ECONNREFUSED')) {
      errMsg = 'ConnectionRefusedError: OmniRoute proxy not running';
    }
    return { status: 'unhealthy', errorDetails: errMsg };
  }
}

export function getUniqueModels(collector: MetricsCollector): ModelResult[] {
  const dbRows = collector.query('SELECT * FROM model_health') as ModelHealthRow[];
  const uniqueMap = new Map<string, { actual_model: string; provider: string; aliases: string[] }>();

  for (const r of dbRows) {
    const dbModelName = String(r.model_name || '');
    if (!dbModelName) continue;

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

  const results: ModelResult[] = [];
  for (const [actualModel, entry] of uniqueMap.entries()) {
    const id = crypto.createHash('sha256').update(actualModel).digest('hex');
    let dbRow = collector.get('SELECT * FROM model_health WHERE id = ?', [id]) as
      | ModelHealthRow
      | undefined;

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
