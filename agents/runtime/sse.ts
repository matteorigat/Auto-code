import { getOcUrl, fetchWithRetry, logErr } from './api.js';

interface SSERuntime {
  sseController: AbortController | null;
  projectPath: string;
  task?: { id?: string } | null;
  running: boolean;
  _completed: boolean;
  sessionId: string | null;
  emit: (event: string, ...args: unknown[]) => boolean;
  _processEvent: (ev: Record<string, unknown>) => void;
  _maybeComplete: () => Promise<void>;
  api: (method: string, path: string) => Promise<unknown>;
}

export class SSEReader {
  runtime: SSERuntime;

  constructor(runtime: SSERuntime) {
    this.runtime = runtime;
  }

  async subscribe(): Promise<void> {
    if (this.runtime.sseController) this.runtime.sseController.abort();
    this.runtime.sseController = new AbortController();

    const baseUrl = await getOcUrl(this.runtime.projectPath, this.runtime.task?.id);
    const url = `${baseUrl}/global/event`;

    fetchWithRetry(
      url,
      {
        headers: {
          'x-opencode-directory': this.runtime.projectPath,
          Accept: 'text/event-stream',
        },
        signal: this.runtime.sseController.signal,
      },
      this.runtime.projectPath,
      'SSE',
    )
      .then(async (res: Response) => {
        if (!res.ok) {
          this.runtime.emit('error', new Error(`SSE ${res.status}`));
          return;
        }
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (this.runtime.running) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
                this.runtime._processEvent(ev);
              } catch (e: unknown) {
                console.error('Ignored error:', (e as Error).message);
              }
            }
          }
        }
      })
      .catch((err: Error & { name?: string }) => {
        if (err.name !== 'AbortError') {
          const msg = `SSE fatal error: ${err.message || String(err)}`;
          logErr(this.runtime.projectPath, 'SSE.subscribe', new Error(msg));
          this.runtime.emit('error', new Error(msg));
        }
      })
      .finally(() => {
        if (this.runtime.running && !this.runtime._completed) {
          this.runtime
            .api('GET', `/session/${this.runtime.sessionId}/message?role=assistant&limit=3`)
            .then((result: unknown) => {
              const msgs = result as Record<string, unknown>[];
              if (
                Array.isArray(msgs) &&
                msgs.some(
                  (m) =>
                    (m.info as Record<string, unknown> | undefined)?.time &&
                    (m.info as Record<string, Record<string, unknown> | undefined>)?.time
                      ?.completed,
                )
              ) {
                this.runtime._completed = true;
                this.runtime._maybeComplete();
              }
            })
            .catch(() => {});
        }
      });
  }
}
