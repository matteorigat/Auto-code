import crypto from 'node:crypto';

interface IdempotencyEntry {
  ts: number;
  result: ApiResponse;
}

export interface ApiResponse {
  ok: boolean;
  result?: unknown;
  [key: string]: unknown;
}

export class TelegramApiClient {
  readonly apiBase: string;
  private readonly idempotencyCache = new Map<string, IdempotencyEntry>();

  constructor(readonly token: string) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  private idempotencyKey(method: string, payload: Record<string, unknown>): string {
    return crypto
      .createHash('md5')
      .update(method + JSON.stringify(payload))
      .digest('hex');
  }

  async callApi(method: string, payload: Record<string, unknown> = {}): Promise<ApiResponse> {
    const url = `${this.apiBase}/${method}`;

    if (method === 'getUpdates') {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return (await res.json()) as ApiResponse;
      } catch {
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
      const result: ApiResponse = (await res.json()) as ApiResponse;
      this.idempotencyCache.set(key, { ts: now, result });

      if (this.idempotencyCache.size > 500) {
        const cutoff = now - 10000;
        for (const [k, v] of this.idempotencyCache) {
          if (v.ts < cutoff) this.idempotencyCache.delete(k);
        }
      }

      return result;
    } catch {
      return { ok: false };
    }
  }
}
