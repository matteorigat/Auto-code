import crypto from 'node:crypto';

export class TelegramApiClient {
  constructor(token) {
    this.token = token;
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this._idempotencyCache = new Map();
  }

  _idempotencyKey(method, payload) {
    const hashStr = method + JSON.stringify(payload);
    return crypto.createHash('md5').update(hashStr).digest('hex');
  }

  async callApi(method, payload = {}) {
    if (method === 'getUpdates') {
      try {
        const res = await fetch(`${this.apiBase}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await res.json();
      } catch {
        return { ok: false };
      }
    }

    const key = this._idempotencyKey(method, payload);
    const now = Date.now();

    const cached = this._idempotencyCache.get(key);
    if (cached && now - cached.ts < 5000) {
      return cached.result || { ok: true, cached: true };
    }

    try {
      const res = await fetch(`${this.apiBase}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();

      this._idempotencyCache.set(key, { ts: now, result });

      if (this._idempotencyCache.size > 500) {
        for (const [k, v] of this._idempotencyCache.entries()) {
          if (now - v.ts > 10000) this._idempotencyCache.delete(k);
        }
      }

      return result;
    } catch {
      return { ok: false };
    }
  }
}
