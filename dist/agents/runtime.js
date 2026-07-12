import { EventEmitter } from 'node:events';
import { getDockerController } from '../src/services/docker-sandbox.js';
import { TaskManager } from '../src/core/task-manager.js';
import { TelemetryClient } from '../src/dashboard/telemetry-client.js';
import { systemPrompts } from '../src/prompts/system-prompts.js';
import { AgentStagnationError, QuotaExceededError, AppError } from '../src/core/errors.js';
import { apiCall, logErr } from './runtime/api.js';
import { buildPrompt } from './runtime/prompt.js';
import { SSEReader } from './runtime/sse.js';
const telemetry = new TelemetryClient();
const DEFAULT_TIMEOUT_MS = 900_000;
const STAGNATION_THRESHOLD = 5; // B10: increased from 3 to reduce false positives
const RATE_LIMIT_BACKOFFS_MS = [15_000, 30_000, 60_000, 120_000]; // exponential backoff steps
export class AgentRuntime extends EventEmitter {
    projectPath;
    agentType;
    task;
    safety;
    stream;
    tasks;
    sessionId;
    sseController;
    running;
    costAccumulator;
    tokensUsed;
    stagnationMap;
    fileChanges;
    lastActivityAt;
    startedAt;
    timedOut;
    _completed;
    lastPrompt;
    _processedMessageIds;
    constructor({ projectPath, agentType = 'builder', task = null, safety = null, stream = null, tasks = null, }) {
        super();
        this.projectPath = projectPath;
        this.agentType = agentType;
        this.task = task;
        this.safety = safety;
        this.stream = stream;
        this.tasks = tasks || new TaskManager({ projectPath });
        this.sessionId = null;
        this.sseController = null;
        this.running = false;
        this.costAccumulator = 0;
        this.tokensUsed = 0;
        this.stagnationMap = new Map();
        this.fileChanges = [];
        this.lastActivityAt = 0;
        this.startedAt = 0;
        this.timedOut = false;
        this._completed = false;
        this._processedMessageIds = new Set();
        this.on('error', () => { });
    }
    emit(eventName, ...args) {
        if (this.stream) {
            if (eventName === 'thinking')
                this.stream.emit('Thought', 'agent', args[0] || {});
            else if (eventName === 'toolCall')
                this.stream.emit('Action', 'agent', args[0] || {});
            else if (eventName === 'error' || eventName === 'runtimeError')
                this.stream.emit('Observation', 'environment', {
                    error: args[0]?.message || args[0],
                });
        }
        return super.emit(eventName, ...args);
    }
    async api(method, path, opts = {}) {
        return apiCall(method, path, this.projectPath, this.task?.id, opts, this.safety);
    }
    async createSession() {
        this.safety?.resetSessionCost?.();
        const title = `${this.agentType} — ${this.task?.title?.slice(0, 60) || 'task'} — ${Date.now().toString(36)}`;
        const session = (await this.api('POST', '/session', { body: { title } }));
        this.sessionId = session.id;
        this.emit('sessionCreated', { sessionId: session.id, title });
        return session.id;
    }
    async abortSession() {
        if (!this.sessionId)
            return;
        try {
            await this.api('POST', `/session/${this.sessionId}/abort`);
            this.emit('sessionAborted', { sessionId: this.sessionId });
        }
        catch (e) {
            this.emit('error', e);
        }
        this.sessionId = null;
    }
    async run(timeoutMs = DEFAULT_TIMEOUT_MS) {
        if (this.running)
            throw new AppError('Runtime already running', 400, 'RUNTIME_RUNNING');
        this.running = true;
        this.startedAt = Date.now();
        this.lastActivityAt = Date.now();
        this.timedOut = false;
        this.costAccumulator = 0;
        this.tokensUsed = 0;
        this.fileChanges = [];
        this.stagnationMap.clear();
        this._processedMessageIds = new Set();
        this._completed = false;
        await this.createSession();
        telemetry.emit('agent.started', 'agent', `Agent ${this.agentType} started`, {
            data: { agentType: this.agentType, taskId: this.task?.id },
            sessionId: this.sessionId,
            taskId: this.task?.id,
        });
        const prompt = buildPrompt(this.projectPath, this.agentType, this.task, this.tasks);
        this.lastPrompt = prompt;
        if (['planner', 'architect', 'reviewer', 'qa', 'visual-reviewer'].includes(this.agentType)) {
            try {
                const { SemanticCache } = await import('../src/core/semantic-cache.js');
                const cache = new SemanticCache(this.projectPath);
                const match = await cache.findMatch(prompt, 0.95);
                if (match && match.hit) {
                    this.emit('log', {
                        level: 'info',
                        message: `🧠 Semantic Cache HIT for ${this.agentType}! Similarity: ${match.similarity != null ? (match.similarity * 100).toFixed(1) : 'N/A'}%`,
                    });
                    this._completed = true;
                    return {
                        ok: true,
                        sessionId: this.sessionId || 'cached',
                        cost: 0,
                        elapsedMs: 0,
                        content: match.content,
                        result: { info: { content: match.content } },
                    };
                }
            }
            catch (e) {
                logErr(this.projectPath, 'semantic-cache', e);
            }
        }
        const parts = [{ type: 'text', text: prompt }];
        if (this.task?._screenshotBase64) {
            parts.push({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${this.task._screenshotBase64}` },
            });
        }
        let postResult;
        try {
            postResult = (await this.api('POST', `/session/${this.sessionId}/message`, {
                body: { parts },
            }));
        }
        catch (e) {
            postResult = null;
        }
        const sse = new SSEReader(this);
        sse.subscribe();
        if (postResult) {
            const info = postResult.info;
            if (info?.time?.completed) {
                this._completed = true;
                await new Promise((r) => setTimeout(r, 2000));
                return Promise.resolve({
                    ok: true,
                    sessionId: this.sessionId || undefined,
                    cost: info?.cost || 0,
                    elapsedMs: Date.now() - this.startedAt,
                });
            }
        }
        const pollingStartsAt = Date.now();
        const pollTimer = setInterval(async () => {
            if (this._completed)
                return;
            try {
                const msgs = await this.api('GET', `/session/${this.sessionId}/message?role=assistant&limit=3`);
                if (Array.isArray(msgs)) {
                    for (const m of msgs) {
                        if (m.info?.time?.completed) {
                            clearInterval(pollTimer);
                            this._maybeComplete();
                            return;
                        }
                    }
                }
                if (Date.now() - pollingStartsAt > 120000) {
                    clearInterval(pollTimer);
                    this._maybeComplete();
                    return;
                }
            }
            catch (e) {
                console.error('Ignored error:', e instanceof Error ? e.message : String(e));
            }
        }, 3000);
        const timeoutTimer = setTimeout(() => {
            this.timedOut = true;
            clearInterval(pollTimer);
            this.emit('timeout', { sessionId: this.sessionId, elapsedMs: Date.now() - this.startedAt });
            this._cleanup();
        }, timeoutMs);
        const stallTimer = setInterval(() => {
            const idle = Date.now() - this.lastActivityAt;
            if (idle > 300_000) {
                this.emit('stallWarning', { idleMs: idle, sessionId: this.sessionId });
            }
        }, 60_000);
        return new Promise((resolve) => {
            if (this._completed) {
                clearTimeout(timeoutTimer);
                clearInterval(stallTimer);
                clearInterval(pollTimer);
                return resolve({
                    ok: true,
                    sessionId: this.sessionId || undefined,
                    cost: this.costAccumulator,
                    elapsedMs: Date.now() - this.startedAt,
                });
            }
            this.once('completed', (data) => {
                clearTimeout(timeoutTimer);
                clearInterval(stallTimer);
                clearInterval(pollTimer);
                resolve({ ok: true, ...data });
            });
            this.once('runtimeError', (err) => {
                clearTimeout(timeoutTimer);
                clearInterval(stallTimer);
                clearInterval(pollTimer);
                resolve({ ok: false, error: err.message || String(err) });
            });
            this.once('timeout', () => {
                clearTimeout(timeoutTimer);
                clearInterval(stallTimer);
                clearInterval(pollTimer);
                resolve({ ok: false, error: 'TIMEOUT', timedOut: true });
            });
            this.once('humanRequired', (data) => {
                clearTimeout(timeoutTimer);
                clearInterval(stallTimer);
                clearInterval(pollTimer);
                resolve({ ok: false, humanRequired: true, ...data });
            });
            this.once('stagnation', (data) => {
                clearTimeout(timeoutTimer);
                clearInterval(stallTimer);
                clearInterval(pollTimer);
                resolve({ ok: false, error: `STAGNATION: ${data.message}` });
            });
        });
    }
    _processEvent(ev) {
        const e = ev;
        if (e.id && this._processedMessageIds.has(e.id))
            return;
        if (e.id)
            this._processedMessageIds.add(e.id);
        this.lastActivityAt = Date.now();
        const type = e.type || e.event || '';
        if (type === 'message.part.updated' && e.properties?.part?.type === 'reasoning') {
            this.emit('thinking', { sessionId: this.sessionId });
            telemetry.emit('agent.thinking', 'agent', 'Agent thinking', {
                sessionId: this.sessionId,
            });
        }
        if (type === 'message.part.updated' && e.properties?.part?.type === 'tool') {
            const tool = e.properties.part.tool || '';
            const title = e.properties.part.state?.title || tool;
            this.emit('toolCall', { sessionId: this.sessionId, tool, title });
            telemetry.emit('agent.tool_call', 'agent', `Tool: ${tool} — ${title}`, {
                data: { tool, title },
                sessionId: this.sessionId,
            });
        }
        if (type === 'session.diff' && Array.isArray(e.properties?.diffs)) {
            for (const d of e.properties.diffs) {
                this.fileChanges.push(d);
            }
            this.emit('filesChanged', this.fileChanges);
            telemetry.emit('agent.files_changed', 'agent', `${this.fileChanges.length} files changed`, {
                data: { files: this.fileChanges.slice(-5) },
                sessionId: this.sessionId,
            });
        }
        if (type === 'message.updated' && e.properties?.info?.role === 'assistant') {
            const info = e.properties.info;
            if (info.tokens) {
                const t = info.tokens;
                this.tokensUsed = (t.input || 0) + (t.output || 0) + (t.cache?.read || 0);
            }
            if (typeof info.cost === 'number') {
                this.costAccumulator += info.cost;
                this.emit('cost', {
                    cost: this.costAccumulator,
                    tokens: this.tokensUsed,
                    sessionId: this.sessionId,
                });
                telemetry.emit('model.call', 'agent', `Cost: $${this.costAccumulator.toFixed(4)}`, {
                    data: { cost: this.costAccumulator, tokens: this.tokensUsed },
                    sessionId: this.sessionId,
                });
            }
            if (info.time?.completed) {
                this._maybeComplete();
            }
        }
        if (type === 'permission.asked' && e.properties?.id) {
            const permissionID = e.properties.id;
            this.emit('log', { level: 'info', message: `Auto-approving permission: ${permissionID}` });
            this.api('POST', `/session/${this.sessionId}/permissions/${permissionID}`, {
                body: { response: 'allow' },
            }).catch((err) => {
                logErr(this.projectPath, 'auto-approve-permission', err);
            });
            return;
        }
        if (type === 'question.asked' || type === 'permission.asked') {
            this.emit('log', { level: 'info', message: `Auto-approved ${type} (${e.properties?.id})` });
            return;
        }
        if (type === 'session.error') {
            const msg = e.properties?.status?.message || 'Unknown session error';
            this._recordError(msg);
        }
        if (type === 'session.status' && e.properties?.status?.type === 'retry') {
            const msg = e.properties.status.message || 'retry';
            this._recordError(msg);
        }
    }
    async _maybeComplete() {
        if (this._completed)
            return;
        this._completed = true;
        let content = '';
        try {
            const msgs = (await this.api('GET', `/session/${this.sessionId}/message?role=assistant&limit=1`));
            if (Array.isArray(msgs) && msgs.length > 0) {
                const lastMsg = msgs[0];
                if (lastMsg.parts && Array.isArray(lastMsg.parts)) {
                    content = lastMsg.parts
                        .map((p) => (typeof p === 'string' ? p : p.text || ''))
                        .join('');
                }
                else if (typeof lastMsg.content === 'string') {
                    content = lastMsg.content;
                }
                else if (lastMsg.text && typeof lastMsg.text === 'string') {
                    content = lastMsg.text;
                }
                else if (lastMsg.info?.content && typeof lastMsg.info.content === 'string') {
                    content = lastMsg.info.content;
                }
            }
        }
        catch {
            // Non-fatal error during content retrieval
        }
        try {
            const prd = this.tasks.readPRD();
            const allStories = [
                ...(prd.crossProjectStories || []),
                ...(prd.projects || []).flatMap((p) => p.stories || []),
            ];
            const allDone = allStories.length > 0 ? allStories.every((s) => s.passes) : false;
            this.emit('completed', {
                sessionId: this.sessionId,
                allDone,
                cost: this.costAccumulator,
                fileChanges: this.fileChanges,
                elapsedMs: Date.now() - this.startedAt,
                content,
                result: { info: { content } },
            });
            telemetry.emit('agent.completed', 'agent', `Agent ${this.agentType} completed`, {
                data: {
                    cost: this.costAccumulator,
                    tokens: this.tokensUsed,
                    elapsedMs: Date.now() - this.startedAt,
                },
                sessionId: this.sessionId,
                taskId: this.task?.id,
            });
            this._storeSotaData(content);
            this._cleanup();
        }
        catch {
            this.emit('completed', {
                sessionId: this.sessionId,
                cost: this.costAccumulator,
                content,
                result: { info: { content } },
            });
            telemetry.emit('agent.completed', 'agent', `Agent ${this.agentType} completed`, {
                data: {
                    cost: this.costAccumulator,
                    tokens: this.tokensUsed,
                    elapsedMs: Date.now() - this.startedAt,
                },
                sessionId: this.sessionId,
                taskId: this.task?.id,
            });
            this._storeSotaData(content);
            this._cleanup();
        }
    }
    async _storeSotaData(content) {
        if (!content || !this.lastPrompt)
            return;
        try {
            const { DistillationLogger } = await import('../src/core/distillation-logger.js');
            const logger = new DistillationLogger(this.projectPath);
            const sysPrompt = systemPrompts[this.agentType] || systemPrompts.builder;
            logger.appendSuccess(sysPrompt, this.lastPrompt, content);
            if (['planner', 'architect', 'reviewer', 'qa', 'visual-reviewer'].includes(this.agentType)) {
                const { SemanticCache } = await import('../src/core/semantic-cache.js');
                const cache = new SemanticCache(this.projectPath);
                await cache.store(this.lastPrompt, content, this.costAccumulator);
            }
        }
        catch (e) {
            logErr(this.projectPath, 'sota-storage', e);
        }
    }
    _maybeCompleteFromResponse(postResult) {
        if (this._completed)
            return;
        this._completed = true;
        let content = '';
        if (postResult) {
            const parts = postResult.parts;
            if (Array.isArray(parts)) {
                content = parts
                    .map((p) => (typeof p === 'string' ? p : p.text || ''))
                    .join('');
            }
            else if (typeof postResult.content === 'string') {
                content = postResult.content;
            }
            else if (typeof postResult.text === 'string') {
                content = postResult.text;
            }
            else {
                const info = postResult.info;
                if (info?.content && typeof info.content === 'string') {
                    content = info.content;
                }
            }
        }
        const info = postResult?.info;
        const cost = this.costAccumulator || info?.cost || 0;
        this.emit('completed', {
            sessionId: this.sessionId,
            allDone: false,
            cost,
            fileChanges: this.fileChanges,
            elapsedMs: Date.now() - this.startedAt,
            content,
            result: postResult || { info: { content } },
        });
        this._storeSotaData(content);
        this._cleanup();
    }
    async _recordError(msg) {
        if (!this.running)
            return;
        const msgLower = msg.toLowerCase();
        const isRateLimit = msgLower.includes('429') ||
            msgLower.includes('rate limit') ||
            msgLower.includes('too many requests');
        if (isRateLimit) {
            // B10: Use exponential backoff for rate limits instead of a flat 60s sleep
            const rateLimitKey = '_rateLimitCount';
            const prevCount = this[rateLimitKey] || 0;
            const backoffMs = RATE_LIMIT_BACKOFFS_MS[Math.min(prevCount, RATE_LIMIT_BACKOFFS_MS.length - 1)];
            this[rateLimitKey] = prevCount + 1;
            telemetry.emit('agent.error', 'agent', msg, {
                level: 'error',
                data: { type: 'rate_limit', attempt: prevCount + 1, backoffMs },
                sessionId: this.sessionId,
            });
            logErr(this.projectPath, 'rate-limit', new QuotaExceededError(`Rate limit hit (attempt ${prevCount + 1}). Sleeping ${backoffMs / 1000}s before retry...`));
            await new Promise((r) => setTimeout(r, backoffMs));
            // Don't abort — let the session continue after the backoff
            return;
        }
        const err = new AgentStagnationError(`Stagnation/Retry: ${msg}`);
        logErr(this.projectPath, 'stagnation', err);
        const key = msgLower.slice(0, 120);
        if (!this.stagnationMap.has(key) && this.stagnationMap.size >= 100) {
            const oldest = this.stagnationMap.keys().next().value;
            if (oldest)
                this.stagnationMap.delete(oldest);
        }
        const prev = this.stagnationMap.get(key) || 0;
        const next = prev + 1;
        this.stagnationMap.set(key, next);
        if (next >= STAGNATION_THRESHOLD) {
            this.emit('stagnation', {
                message: msg,
                occurrences: next,
                sessionId: this.sessionId,
            });
            telemetry.emit('agent.error', 'agent', msg, {
                level: 'error',
                data: { type: 'stagnation', occurrences: next },
                sessionId: this.sessionId,
            });
            this._cleanup();
        }
        else {
            this._cleanup();
            this.emit('runtimeError', err);
        }
    }
    _cleanup() {
        this.running = false;
        if (this.sseController) {
            this.sseController.abort();
            this.sseController = null;
        }
        if (this.task && this.task.id) {
            try {
                const controller = getDockerController(this.projectPath);
                controller.stopSandbox(this.task.id);
            }
            catch (e) {
                console.error('[AgentRuntime] failed to stop sandbox on cleanup:', e instanceof Error ? e.message : String(e));
            }
        }
    }
    stop() {
        this._cleanup();
        this.abortSession();
    }
}
export default AgentRuntime;
