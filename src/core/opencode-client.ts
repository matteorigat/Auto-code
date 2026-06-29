import { EventEmitter } from 'node:events';

interface ProcessManager {
  OC_PORT: number;
  healthOk: boolean;
}

export class OpenCodeClient {
  processManager: ProcessManager;
  sseController: AbortController | null;
  eventBus: EventEmitter;

  constructor(processManager: ProcessManager) {
    this.processManager = processManager;
    this.sseController = null;
    this.eventBus = new EventEmitter();
  }

  get OC_URL(): string {
    return `http://127.0.0.1:${this.processManager.OC_PORT}`;
  }

  async api(
    path: string,
    opts: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      raw?: boolean;
      rawResponse?: boolean;
      directory?: string;
    } = {},
  ): Promise<unknown> {
    if (!this.processManager.healthOk && !path.startsWith('/api/health')) {
      throw new Error('opencode server unavailable');
    }
    const url = `${this.OC_URL}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-directory': opts.directory || '',
        ...opts.headers,
      },
      body: opts.body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${path}: ${res.status} ${text.substring(0, 200)}`);
    }
    if (opts.raw || opts.rawResponse) return res;
    return res.json();
  }

  async createSession(directory?: string): Promise<{ id: string }> {
    return this.api('/session', {
      method: 'POST',
      body: JSON.stringify({}),
      directory,
    }) as Promise<{ id: string }>;
  }

  async listSessions(directory?: string) {
    return this.api('/session?limit=20', { directory });
  }

  async sendPrompt(sessionId: string, text: string, directory?: string) {
    return this.api(`/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      directory,
    });
  }

  async abortSession(sessionId: string, directory?: string) {
    return this.api(`/session/${sessionId}/abort`, { method: 'POST', directory });
  }

  async getSessionStatus(directory?: string) {
    return this.api('/session/status', { directory });
  }

  async subscribeEvents(directory: string | undefined | null, onStopTyping?: () => void) {
    if (this.sseController) {
      this.sseController.abort();
    }
    this.sseController = new AbortController();

    try {
      const res = await fetch(`${this.OC_URL}/global/event`, {
        headers: {
          'x-opencode-directory': directory || '',
          Accept: 'text/event-stream',
        },
        signal: this.sseController.signal,
      });
      if (!res.ok) {
        console.error('SSE connection failed:', res.status);
        return;
      }

      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              this.eventBus.emit('event', data);
              if (
                data.type === 'message.updated' &&
                data.properties?.info?.time?.completed &&
                onStopTyping
              ) {
                onStopTyping();
              }
            } catch (err: unknown) {
              if (err instanceof Error) console.error('Ignored error:', err.message);
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError')
        console.error('SSE error:', err.message);
    }
    this.sseController = null;
  }

  stopAll() {
    if (this.sseController) {
      this.sseController.abort();
      this.sseController = null;
    }
  }
}
