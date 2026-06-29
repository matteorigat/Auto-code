import crypto from 'node:crypto';
export class TelegramApiClient {
    token;
    apiBase;
    idempotencyCache = new Map();
    constructor(token) {
        this.token = token;
        this.apiBase = `https://api.telegram.org/bot${token}`;
    }
    idempotencyKey(method, payload) {
        return crypto
            .createHash('md5')
            .update(method + JSON.stringify(payload))
            .digest('hex');
    }
    async callApi(method, payload = {}) {
        const url = `${this.apiBase}/${method}`;
        if (method === 'getUpdates') {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                return (await res.json());
            }
            catch {
                return { ok: false };
            }
        }
        const key = this.idempotencyKey(method, payload);
        const now = Date.now();
        const cached = this.idempotencyCache.get(key);
        if (cached && now - cached.ts < 5000) {
            return cached.result;
        }
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const result = (await res.json());
            this.idempotencyCache.set(key, { ts: now, result });
            if (this.idempotencyCache.size > 500) {
                const cutoff = now - 10000;
                for (const [k, v] of this.idempotencyCache) {
                    if (v.ts < cutoff)
                        this.idempotencyCache.delete(k);
                }
            }
            return result;
        }
        catch {
            return { ok: false };
        }
    }
}
