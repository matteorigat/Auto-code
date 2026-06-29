import crypto from 'node:crypto';
export class ModelHealthTracker {
    metricsDb;
    constructor(metricsDb) {
        this.metricsDb = metricsDb;
    }
    upsertModelHealth(id, modelName, status, errorDetails, lastCheck, lastSuccess) {
        const row = this.metricsDb.get('SELECT health_status, failure_streak FROM model_health WHERE id = ?', [id]);
        const prevStreak = row?.failure_streak || 0;
        const newStreak = status === 'healthy' ? 0 : prevStreak + 1;
        this.metricsDb
            .prepare(`
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
    `)
            .run(id, modelName, status, errorDetails, lastCheck, lastSuccess, newStreak, newStreak);
    }
    recordCallResult(fullModel, provider, status, errorDetails, timestamp) {
        const healthStatus = status === 'ok' ? 'healthy' : 'unhealthy';
        const lastSuccess = status === 'ok' ? timestamp : 'None';
        const id = crypto.createHash('sha256').update(fullModel).digest('hex');
        this.upsertModelHealth(id, fullModel, healthStatus, errorDetails, timestamp, lastSuccess);
    }
}
