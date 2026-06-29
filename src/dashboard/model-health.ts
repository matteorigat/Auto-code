import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import crypto from 'node:crypto';
import type { MetricsDB } from './metrics-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ModelHealthTracker {
  metricsDb: MetricsDB;

  constructor(metricsDb: MetricsDB) {
    this.metricsDb = metricsDb;
  }

  upsertModelHealth(
    id: string,
    modelName: string,
    status: string,
    errorDetails: string,
    lastCheck: string,
    lastSuccess: string,
  ): void {
    const row = this.metricsDb.get(
      'SELECT health_status, failure_streak FROM model_health WHERE id = ?',
      [id],
    ) as { health_status?: string; failure_streak?: number } | undefined;
    const prevStatus = row?.health_status || 'unchecked';
    const prevStreak = row?.failure_streak || 0;
    const newStreak = status === 'healthy' ? 0 : prevStatus === 'unchecked' ? 1 : prevStreak + 1;

    this.metricsDb
      .prepare(
        `
      INSERT INTO model_health (id, model_name, health_status, error_details, last_check, last_success, failure_streak)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        health_status = excluded.health_status,
        error_details = excluded.error_details,
        last_check = excluded.last_check,
        last_success = CASE 
          WHEN excluded.health_status = 'healthy' THEN excluded.last_success 
          ELSE model_health.last_success 
        END,
        failure_streak = ?
    `,
      )
      .run(id, modelName, status, errorDetails, lastCheck, lastSuccess, newStreak, newStreak);
  }

  getAliasesForModel(provider: string, model: string): string[] {
    let normalizedModel = model;
    if (provider === 'opencode' || provider === 'opencode_zen') {
      if (normalizedModel.startsWith('openai/')) {
        normalizedModel = normalizedModel.replace('openai/', 'opencode/');
      } else if (!normalizedModel.includes('/')) {
        normalizedModel = 'opencode/' + normalizedModel;
      }
    }

    const aliases: string[] = [];
    try {
      const configPath = join(__dirname, '..', '..', 'config', 'litellm.yaml');
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, 'utf8');
        const parsed = parse(raw) as { model_list?: Record<string, unknown>[] };
        const models = parsed.model_list || [];
        for (const m of models) {
          if (!m.model_name) continue;

          let mModel =
            ((m.litellm_params as Record<string, unknown>)?.model as string) ||
            (m.model_name as string);
          const mProvider =
            ((m.model_info as Record<string, unknown>)?.provider as string) || 'unknown';
          if (mProvider === 'opencode_zen' || mProvider === 'opencode') {
            if (mModel.startsWith('openai/')) {
              mModel = mModel.replace('openai/', 'opencode/');
            } else if (!mModel.includes('/')) {
              mModel = 'opencode/' + mModel;
            }
          }

          if (
            mModel === normalizedModel ||
            m.model_name === model ||
            m.model_name === normalizedModel
          ) {
            aliases.push(m.model_name as string);
          }
        }
      }
    } catch (e: unknown) {
      console.warn(
        '[ModelHealthTracker] failed to resolve aliases for model:',
        (e as Error).message,
      );
    }
    return aliases;
  }

  recordCallResult(
    fullModel: string,
    provider: string,
    status: string,
    errorDetails: string,
    timestamp: string,
  ): void {
    const healthStatus = status === 'ok' ? 'healthy' : 'unhealthy';
    const lastSuccess = status === 'ok' ? timestamp : 'None';

    const id = crypto.createHash('sha256').update(fullModel).digest('hex');
    this.upsertModelHealth(id, fullModel, healthStatus, errorDetails, timestamp, lastSuccess);

    const aliases = this.getAliasesForModel(provider, fullModel);
    for (const alias of aliases) {
      if (alias !== fullModel) {
        const aliasId = crypto.createHash('sha256').update(alias).digest('hex');
        this.upsertModelHealth(aliasId, alias, healthStatus, errorDetails, timestamp, lastSuccess);
      }
    }
  }
}
