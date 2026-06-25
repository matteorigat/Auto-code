import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ModelHealthTracker {
  /**
   * @param {import("./metrics-db.mjs").MetricsDB} metricsDb
   */
  constructor(metricsDb) {
    this.metricsDb = metricsDb;
  }

  upsertModelHealth(id, modelName, status, errorDetails, lastCheck, lastSuccess) {
    const row = this.metricsDb.get(
      'SELECT health_status, failure_streak FROM model_health WHERE id = ?',
      [id],
    );
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

  getAliasesForModel(provider, model) {
    let normalizedModel = model;
    if (provider === 'opencode' || provider === 'opencode_zen') {
      if (normalizedModel.startsWith('openai/')) {
        normalizedModel = normalizedModel.replace('openai/', 'opencode/');
      } else if (!normalizedModel.includes('/')) {
        normalizedModel = 'opencode/' + normalizedModel;
      }
    }

    const aliases = [];
    try {
      const configPath = join(__dirname, '..', '..', 'config', 'litellm.yaml');
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, 'utf8');
        const parsed = parse(raw);
        const models = parsed.model_list || [];
        for (const m of models) {
          if (!m.model_name) continue;

          let mModel = m.litellm_params?.model || m.model_name;
          let mProvider = m.model_info?.provider || 'unknown';
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
            aliases.push(m.model_name);
          }
        }
      }
    } catch (e) {
      console.warn('[ModelHealthTracker] failed to resolve aliases for model:', e.message);
    }
    return aliases;
  }

  recordCallResult(fullModel, provider, status, errorDetails, timestamp) {
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
