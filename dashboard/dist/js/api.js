export class DashboardAPI {
    constructor(token = null) {
        this.token = token || localStorage.getItem('dashboard_token');
    }
    _headers() {
        const headers = {};
        if (this.token)
            headers['Authorization'] = `Bearer ${this.token}`;
        return headers;
    }
    async _parseResponse(res) {
        if (res.status === 401)
            throw new Error('Unauthorized');
        if (res.status === 204)
            return null;
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text().catch(() => '');
            if (!res.ok)
                throw new Error(text || `HTTP ${res.status}`);
            return text ? JSON.parse(text) : null;
        }
        const data = await res.json();
        if (!res.ok)
            throw new Error(data?.error || `HTTP ${res.status}`);
        return data;
    }
    async get(path, { timeout = 15000 } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(`/api${path}`, {
                headers: this._headers(),
                signal: controller.signal,
            });
            return await this._parseResponse(res);
        }
        catch (err) {
            if (err.name === 'AbortError')
                throw new Error('Request timeout', { cause: err });
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async post(path, body, { timeout = 15000 } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const headers = { 'Content-Type': 'application/json', ...this._headers() };
            const res = await fetch(`/api${path}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            return await this._parseResponse(res);
        }
        catch (err) {
            if (err.name === 'AbortError')
                throw new Error('Request timeout', { cause: err });
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async delete(path, { timeout = 15000 } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(`/api${path}`, {
                method: 'DELETE',
                headers: this._headers(),
                signal: controller.signal,
            });
            return await this._parseResponse(res);
        }
        catch (err) {
            if (err.name === 'AbortError')
                throw new Error('Request timeout', { cause: err });
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
