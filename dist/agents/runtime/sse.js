import { getOcUrl, fetchWithRetry, logErr } from './api.js';
export class SSEReader {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    async subscribe() {
        if (this.runtime.sseController)
            this.runtime.sseController.abort();
        this.runtime.sseController = new AbortController();
        const baseUrl = await getOcUrl(this.runtime.projectPath, this.runtime.task?.id);
        const url = `${baseUrl}/global/event`;
        fetchWithRetry(url, {
            headers: {
                'x-opencode-directory': this.runtime.projectPath,
                Accept: 'text/event-stream',
            },
            signal: this.runtime.sseController.signal,
        }, this.runtime.projectPath, 'SSE')
            .then(async (res) => {
            if (!res.ok) {
                this.runtime.emit('error', new Error(`SSE ${res.status}`));
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (this.runtime.running) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const ev = JSON.parse(line.slice(6));
                            this.runtime._processEvent(ev);
                        }
                        catch (e) {
                            console.error('Ignored error:', e.message);
                        }
                    }
                }
            }
        })
            .catch((err) => {
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
                    .then((result) => {
                    const msgs = result;
                    if (Array.isArray(msgs) &&
                        msgs.some((m) => m.info?.time &&
                            m.info?.time
                                ?.completed)) {
                        this.runtime._completed = true;
                        this.runtime._maybeComplete();
                    }
                })
                    .catch(() => { });
            }
        });
    }
}
