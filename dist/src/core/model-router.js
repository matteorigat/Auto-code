import http from 'node:http';
import crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { getTelemetryClient } from '../dashboard/telemetry-client.js';
class SessionManager {
    sessions = new Map();
    maxSessions = 200;
    ttlMs = 15 * 60 * 1000;
    constructor() {
        const timer = setInterval(() => this.cleanup(), 60_000);
        timer.unref();
    }
    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.sessions) {
            if (now - entry.lastActive > this.ttlMs) {
                this.sessions.delete(key);
            }
        }
        while (this.sessions.size > this.maxSessions) {
            let oldestKey = null;
            let oldestTime = Infinity;
            for (const [key, entry] of this.sessions) {
                if (entry.lastActive < oldestTime) {
                    oldestTime = entry.lastActive;
                    oldestKey = key;
                }
            }
            if (oldestKey)
                this.sessions.delete(oldestKey);
        }
    }
    generateId(body, connectionId, provider) {
        if (!body || typeof body !== 'object')
            return null;
        const parts = [];
        if (body.model)
            parts.push(`model:${body.model}`);
        if (provider)
            parts.push(`provider:${provider}`);
        const systemPrompt = this.extractSystemPrompt(body);
        if (systemPrompt)
            parts.push(`sys:${this.hashShort(systemPrompt)}`);
        const firstUser = this.extractFirstUserMessage(body);
        if (firstUser)
            parts.push(`user0:${this.hashShort(firstUser)}`);
        if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
            const toolNames = body.tools
                .map((t) => t.name || t.function?.name || '')
                .filter(Boolean)
                .sort()
                .join(',');
            if (toolNames)
                parts.push(`tools:${this.hashShort(toolNames)}`);
        }
        if (connectionId)
            parts.push(`conn:${connectionId}`);
        if (parts.length === 0)
            return null;
        const fingerprint = parts.join('|');
        return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
    }
    touch(sessionId, slotId = null) {
        if (!sessionId)
            return;
        const existing = this.sessions.get(sessionId);
        if (existing) {
            existing.lastActive = Date.now();
            existing.requestCount++;
            if (slotId)
                existing.slotId = slotId;
        }
        else {
            this.sessions.set(sessionId, {
                createdAt: Date.now(),
                lastActive: Date.now(),
                requestCount: 1,
                slotId,
            });
        }
    }
    getSlotAffinity(sessionId) {
        if (!sessionId)
            return null;
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return null;
        if (Date.now() - entry.lastActive > this.ttlMs) {
            this.sessions.delete(sessionId);
            return null;
        }
        return entry.slotId;
    }
    getActiveCount() {
        return this.sessions.size;
    }
    extractSystemPrompt(body) {
        if (body.system) {
            return typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
        }
        if (Array.isArray(body.messages)) {
            const sys = body.messages.find((m) => m.role === 'system' || m.role === 'developer');
            if (sys) {
                return typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content);
            }
        }
        return null;
    }
    extractFirstUserMessage(body) {
        const messages = body.messages || body.input || [];
        if (!Array.isArray(messages))
            return null;
        for (const msg of messages) {
            if (msg.role === 'user') {
                return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            }
        }
        return null;
    }
    hashShort(text) {
        return createHash('sha256').update(text).digest('hex').slice(0, 8);
    }
}
// ─── Thinking Model Helpers (from OmniRoute) ──────────────────────────────
const THINKING_MODEL_PATTERNS = [
    /deepseek/i,
    /\bkimi\b/i,
    /\bk2\b/i,
    /\bminimax\b/i,
];
function isThinkingMessageModel(model) {
    if (!model || typeof model !== 'string')
        return false;
    return THINKING_MODEL_PATTERNS.some((re) => re.test(model));
}
function injectReasoningContentForThinkingModel(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return body;
    const record = body;
    if (!Array.isArray(record.messages))
        return body;
    let modified = false;
    const messages = record.messages.map((message) => {
        if (!message || typeof message !== 'object' || Array.isArray(message))
            return message;
        const msg = message;
        if (msg.role !== 'assistant')
            return message;
        if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim().length > 0)
            return message;
        modified = true;
        return { ...msg, reasoning_content: ' ' };
    });
    return modified ? { ...record, messages } : body;
}
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
];
const TIER_MODELS = {
    'tier-4-planner': [
        { id: 'big-pickle', name: 'Big Pickle', tier: 'tier-4', provider: 'opencode-free' },
        { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super', tier: 'tier-4', provider: 'opencode-free' },
        { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'tier-4', provider: 'openrouter' },
    ],
    'tier-3-builder': [
        { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash', tier: 'tier-3', provider: 'opencode-free' },
        { id: 'minimax-m2.5-free', name: 'MiniMax M2.5', tier: 'tier-3', provider: 'opencode-free' },
        { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', tier: 'tier-3', provider: 'openrouter' },
    ],
    'tier-2-hunter': [
        { id: 'north-mini-code-free', name: 'North Mini Code', tier: 'tier-2', provider: 'opencode-free' },
        { id: 'minimax-m3-free', name: 'MiniMax M3', tier: 'tier-2', provider: 'opencode-free' },
        { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', tier: 'tier-2', provider: 'openrouter' },
    ],
    'tier-1-trivial': [
        { id: 'minimax-m3-free', name: 'MiniMax M3', tier: 'tier-1', provider: 'opencode-free' },
        { id: 'qwen3.6-plus-free', name: 'Qwen 3.6 Plus', tier: 'tier-1', provider: 'opencode-free' },
        { id: 'meta-llama/llama-4-scout', name: 'Llama 4 Scout', tier: 'tier-1', provider: 'openrouter' },
    ],
};
const MODEL_ALIASES = {
    'auto/best-reasoning': 'big-pickle',
    'auto/best-coding': 'deepseek-v4-flash-free',
    'auto/fast': 'minimax-m3-free',
    'auto/fastest': 'qwen3.6-plus-free',
};
const CIRCUIT_BREAKER = {
    failureThreshold: 3,
    backoffBaseMs: 30_000,
    backoffMaxMs: 300_000,
    backoffMultiplier: 2,
};
const MAX_LOG_ENTRIES = 200;
export class ModelRouter {
    port;
    server;
    slots = [];
    nextFreeSlotIdx = 0;
    started = false;
    startTime = Date.now();
    modelStats = new Map();
    requestLog = [];
    sessionManager = new SessionManager();
    totalRequests = 0;
    totalFailures = 0;
    zenApiKey;
    openrouterApiKey;
    constructor(port = 20128) {
        this.port = port;
        this.zenApiKey = process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_API_KEY;
        this.openrouterApiKey = process.env.OPENROUTER_API_KEY;
        this.buildSlots();
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
    }
    buildSlots() {
        const freeSlots = 36;
        for (let i = 1; i <= freeSlots; i++) {
            this.slots.push({
                cfg: {
                    id: `oc-free-${String(i).padStart(2, '0')}`,
                    tier: 'opencode-free',
                    baseUrl: 'https://opencode.ai/zen/v1',
                    fingerprint: this.generateFingerprint(i),
                },
                cooldownUntil: 0,
                failureCount: 0,
                totalCalls: 0,
                totalTokensIn: 0,
                totalTokensOut: 0,
                lastCallAt: null,
                lastError: null,
                lastLatencyMs: null,
                status: 'active',
            });
        }
        if (this.zenApiKey) {
            for (let i = 1; i <= 6; i++) {
                this.slots.push({
                    cfg: {
                        id: `oc-zen-${String(i).padStart(2, '0')}`,
                        tier: 'opencode-zen',
                        baseUrl: 'https://opencode.ai/zen/v1',
                        apiKey: this.zenApiKey,
                        fingerprint: this.generateFingerprint(36 + i),
                    },
                    cooldownUntil: 0,
                    failureCount: 0,
                    totalCalls: 0,
                    totalTokensIn: 0,
                    totalTokensOut: 0,
                    lastCallAt: null,
                    lastError: null,
                    lastLatencyMs: null,
                    status: 'active',
                });
            }
        }
        if (this.openrouterApiKey) {
            for (let i = 1; i <= 4; i++) {
                this.slots.push({
                    cfg: {
                        id: `or-${String(i).padStart(2, '0')}`,
                        tier: 'openrouter',
                        baseUrl: 'https://openrouter.ai/api/v1',
                        apiKey: this.openrouterApiKey,
                        fingerprint: this.generateFingerprint(42 + i),
                    },
                    cooldownUntil: 0,
                    failureCount: 0,
                    totalCalls: 0,
                    totalTokensIn: 0,
                    totalTokensOut: 0,
                    lastCallAt: null,
                    lastError: null,
                    lastLatencyMs: null,
                    status: 'active',
                });
            }
        }
        console.log(`[ModelRouter] Built ${this.slots.length} slots: ` +
            `${freeSlots} free, ${this.zenApiKey ? 6 : 0} zen, ${this.openrouterApiKey ? 4 : 0} openrouter`);
    }
    generateFingerprint(seed) {
        const ua = USER_AGENTS[seed % USER_AGENTS.length];
        const suffix = seed.toString(36).padStart(4, '0');
        return `OCB-${suffix}-${crypto.createHash('md5').update(`${seed}:${ua}`).digest('hex').slice(0, 8)}`;
    }
    /**
     * Round-robin pick a ready free slot, skipping cooldown slots.
     */
    pickFreeSlot() {
        const freeSlots = this.slots.filter((s) => s.cfg.tier === 'opencode-free');
        if (freeSlots.length === 0)
            return null;
        for (let i = 0; i < freeSlots.length; i++) {
            const idx = (this.nextFreeSlotIdx + i) % freeSlots.length;
            const slot = freeSlots[idx];
            if (slot.status !== 'disabled' && slot.cooldownUntil <= Date.now()) {
                this.nextFreeSlotIdx = (idx + 1) % freeSlots.length;
                return slot;
            }
        }
        return null;
    }
    /**
     * Mark a slot for cooldown with exponential backoff (from OmniRoute pattern).
     */
    markSlotCooldown(slot) {
        slot.failureCount++;
        const backoff = Math.min(CIRCUIT_BREAKER.backoffBaseMs * Math.pow(CIRCUIT_BREAKER.backoffMultiplier, slot.failureCount - 1), CIRCUIT_BREAKER.backoffMaxMs);
        slot.cooldownUntil = Date.now() + backoff + Math.random() * 1000;
        slot.status = slot.failureCount >= CIRCUIT_BREAKER.failureThreshold ? 'circuit-open' : 'cooldown';
    }
    markSlotSuccess(slot) {
        slot.failureCount = 0;
        slot.cooldownUntil = 0;
        slot.status = 'active';
    }
    start() {
        if (this.started)
            return;
        this.server.listen(this.port, '127.0.0.1');
        this.started = true;
        console.log(`[ModelRouter] listening on http://127.0.0.1:${this.port}`);
    }
    stop() {
        this.started = false;
        this.server.close();
    }
    async handleRequest(req, res) {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const path = url.pathname;
            // Log incoming request for debugging
            const truncated = path.length > 80 ? path.slice(0, 80) + '...' : path;
            console.log(`[ModelRouter] ${req.method} ${truncated}`);
            // Normalize path: some AI SDKs double-append /v1 (e.g. /v1/v1/chat/completions)
            const normalized = this.normalizePath(path);
            if (req.method === 'GET' && (normalized === '/v1/models' || path === '/v1/models'))
                return this.handleModels(res);
            if (req.method === 'POST' && (normalized === '/v1/chat/completions' || path === '/v1/chat/completions'))
                return this.handleChatCompletion(req, res);
            if (req.method === 'GET' && path === '/api/health')
                return this.respondJson(res, 200, this.getHealth());
            if (req.method === 'GET' && path === '/api/monitoring/health')
                return this.respondJson(res, 200, this.getMonitoringHealth());
            if (req.method === 'GET' && path === '/api/providers/health-matrix')
                return this.respondJson(res, 200, this.getHealthMatrix());
            if (req.method === 'GET' && path === '/api/model-router/accounts')
                return this.respondJson(res, 200, this.getAccounts());
            if (req.method === 'GET' && path === '/api/model-router/stats')
                return this.respondJson(res, 200, this.getStats());
            if (req.method === 'GET' && path === '/api/model-router/logs')
                return this.respondJson(res, 200, this.getLogs());
            if (req.method === 'GET' && path === '/api/model-router/models')
                return this.respondJson(res, 200, this.getModelDetails());
            if (req.method === 'POST' && path === '/api/model-router/reset-slot')
                return this.handleResetSlot(req, res);
            this.respondJson(res, 404, { error: 'not found', path });
        }
        catch (err) {
            this.respondJson(res, 500, { error: err.message });
        }
    }
    /**
     * Normalize path by stripping duplicate /v1/ prefixes.
     * Also handle missing /v1 prefix for AI SDKs that construct baseURL differently.
     */
    normalizePath(path) {
        // /v1/v1/... → /v1/...
        let p = path.replace(/^\/v1\/v1\//, '/v1/');
        // /chat/completions → /v1/chat/completions (for SDKs that don't add /v1)
        p = p.replace(/^\/chat\//, '/v1/chat/');
        return p;
    }
    async handleModels(res) {
        const models = [];
        const seen = new Set();
        const prefixes = ['model-router', 'openai'];
        for (const prefix of prefixes) {
            for (const entries of Object.values(TIER_MODELS)) {
                for (const m of entries) {
                    const key = `${prefix}/${m.id}`;
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    models.push({
                        id: key,
                        object: 'model',
                        created: Math.floor(this.startTime / 1000),
                        owned_by: m.provider,
                        tier: m.tier,
                    });
                }
            }
            for (const alias of Object.keys(MODEL_ALIASES)) {
                const key = `${prefix}/${alias}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                models.push({
                    id: key,
                    object: 'model',
                    created: Math.floor(this.startTime / 1000),
                    owned_by: 'opencode-free',
                    tier: 'alias',
                });
            }
            for (const tierName of Object.keys(TIER_MODELS)) {
                const key = `${prefix}/${tierName}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                models.push({
                    id: key,
                    object: 'model',
                    created: Math.floor(this.startTime / 1000),
                    owned_by: 'model-router',
                    tier: tierName,
                });
            }
        }
        this.respondJson(res, 200, { object: 'list', data: models });
    }
    async handleChatCompletion(req, res) {
        const body = await this.readBody(req);
        const requestedModel = body.model || '';
        const clientHeaders = req.headers;
        // Resolve model early for session fingerprint
        const resolvedModel = this.resolveModel(requestedModel);
        // ── Session management (inspired by OmniRoute's sessionManager.ts) ──
        // Extract session ID from multiple header variants (OmniRoute pattern)
        const extSessionId = this.extractHeader(clientHeaders, 'x-session-id')
            || this.extractHeader(clientHeaders, 'x-session-affinity')
            || this.extractHeader(clientHeaders, 'x_session_id')
            || this.extractHeader(clientHeaders, 'x-omniroute-session')
            || this.extractHeader(clientHeaders, 'session-id');
        const sessionId = extSessionId
            ? `ext:${extSessionId.trim().slice(0, 64)}`
            : this.sessionManager.generateId(body, undefined, resolvedModel?.includes('/') ? resolvedModel.split('/')[0] : 'model-router');
        this.sessionManager.touch(sessionId, null);
        const affinitySlotId = this.sessionManager.getSlotAffinity(sessionId);
        const resolvedEntries = this.resolveModelEntries(resolvedModel);
        if (resolvedEntries.length === 0) {
            return this.respondJson(res, 400, { error: { message: `No provider for model: ${requestedModel}`, type: 'invalid_model' } });
        }
        const isStream = body.stream === true;
        // ── Thinking model injection (from OmniRoute) ──
        let modifiedBody = body;
        if (isThinkingMessageModel(resolvedModel)) {
            modifiedBody = injectReasoningContentForThinkingModel(body);
        }
        // ── Build candidates with round-robin for free slots ──
        const candidates = this.buildCandidates(resolvedEntries, affinitySlotId);
        if (candidates.length === 0) {
            return this.respondJson(res, 503, {
                error: {
                    message: 'All providers exhausted',
                    type: 'providers_exhausted',
                    hint: 'Tutti i provider hanno fallito. Riprova tra qualche secondo.',
                },
            });
        }
        const reqId = crypto.randomUUID();
        for (const candidate of candidates) {
            const slot = candidate.slot;
            if (slot.status === 'disabled')
                continue;
            if (slot.cooldownUntil > Date.now())
                continue;
            const callStart = Date.now();
            try {
                const result = await this.callUpstream(slot, candidate.upstreamModel, modifiedBody, isStream, clientHeaders, sessionId);
                this.markSlotSuccess(slot);
                slot.totalCalls++;
                slot.lastCallAt = callStart;
                slot.lastLatencyMs = Date.now() - callStart;
                slot.lastError = null;
                // Bind session to this slot for sticky routing
                if (sessionId)
                    this.sessionManager.touch(sessionId, slot.cfg.id);
                const tokensIn = body.messages?.reduce?.((sum, m) => sum + (m.content?.length || 0), 0) || 0;
                let tokensOut = 0;
                let responseContent = '';
                if (isStream) {
                    const streamingResult = await this.streamResponse(result, res, req);
                    tokensOut = streamingResult.tokensOut;
                    responseContent = streamingResult.content;
                }
                else {
                    tokensOut = (result.usage?.completion_tokens || 0);
                    responseContent = result?.choices?.[0]?.message?.content || '';
                    this.respondJson(res, 200, result);
                }
                const prompt = this.extractPrompt(body);
                slot.totalTokensIn += tokensIn;
                slot.totalTokensOut += tokensOut;
                this.recordModelStat(candidate.upstreamModel, tokensIn, tokensOut, true, callStart);
                this.totalRequests++;
                this.logRequest({
                    id: reqId,
                    slotId: slot.cfg.id,
                    model: candidate.upstreamModel,
                    tier: slot.cfg.tier,
                    status: 200,
                    tokensIn,
                    tokensOut,
                    latencyMs: Date.now() - callStart,
                    error: null,
                    ts: callStart,
                });
                // Push telemetry to dashboard
                this.pushTelemetry(candidate.upstreamModel, slot, tokensIn, tokensOut, sessionId, prompt, responseContent);
                if (isStream)
                    return;
            }
            catch (err) {
                const errorMessage = err.message;
                this.markSlotCooldown(slot);
                slot.lastError = errorMessage;
                slot.lastLatencyMs = Date.now() - callStart;
                this.recordModelStat(candidate.upstreamModel, 0, 0, false, callStart);
                this.totalFailures++;
                this.logRequest({
                    id: reqId,
                    slotId: slot.cfg.id,
                    model: candidate.upstreamModel,
                    tier: slot.cfg.tier,
                    status: 502,
                    tokensIn: 0,
                    tokensOut: 0,
                    latencyMs: Date.now() - callStart,
                    error: errorMessage,
                    ts: callStart,
                });
                console.warn(`[ModelRouter] ${slot.cfg.id} failed (${slot.failureCount}x): ${errorMessage}`);
                // For free tier 401/model-not-supported: skip slot silently and try next
                const isFreeSlot = slot.cfg.tier === 'opencode-free';
                const isRateLimitOrAuth = errorMessage.includes('429') || errorMessage.includes('401') || errorMessage.includes('model not supported');
                if (isFreeSlot && isRateLimitOrAuth) {
                    continue;
                }
                // For non-free or other errors, also try next candidate
                continue;
            }
        }
        // Reset all circuit-open free slots to cooldown
        this.slots
            .filter((s) => s.cfg.tier === 'opencode-free' && s.status === 'circuit-open')
            .forEach((s) => {
            s.cooldownUntil = Date.now() + CIRCUIT_BREAKER.backoffBaseMs;
            s.failureCount = 0;
            s.status = 'cooldown';
        });
        this.respondJson(res, 503, {
            error: {
                message: 'All providers exhausted',
                type: 'providers_exhausted',
                hint: 'Tutti i provider hanno fallito. Riprova tra qualche secondo.',
            },
        });
    }
    extractHeader(headers, name) {
        const val = headers[name];
        if (Array.isArray(val))
            return val[0];
        return val;
    }
    resolveModel(model) {
        const parts = model.split('/');
        const name = parts.length >= 2 ? parts.slice(1).join('/') : parts[0];
        return MODEL_ALIASES[name] || name;
    }
    resolveModelEntries(resolvedModel) {
        if (TIER_MODELS[resolvedModel])
            return [...TIER_MODELS[resolvedModel]];
        for (const entries of Object.values(TIER_MODELS)) {
            const found = entries.find((m) => m.id === resolvedModel);
            if (found) {
                return entries.filter((e) => e.tier === found.tier && e.provider === found.provider);
            }
        }
        return [{ id: resolvedModel, name: resolvedModel, tier: 'tier-3', provider: 'opencode-free' }];
    }
    buildCandidates(entries, affinitySlotId) {
        const candidates = [];
        for (const entry of entries) {
            if (entry.provider === 'opencode-free') {
                // Round-robin across ready free slots (inspired by OmniRoute's OpencodeExecutor)
                const picked = this.pickFreeSlot();
                if (picked) {
                    const p = affinitySlotId && picked.cfg.id === affinitySlotId ? 0 : 1;
                    candidates.push({ slot: picked, upstreamModel: entry.id, priority: p });
                }
            }
            else {
                const matchingSlots = this.slots.filter((s) => s.cfg.tier === entry.provider && s.status !== 'disabled');
                const priority = entry.provider === 'opencode-zen' ? 2 : 3;
                for (const slot of matchingSlots) {
                    let p = priority;
                    if (affinitySlotId && slot.cfg.id === affinitySlotId)
                        p = 0;
                    candidates.push({ slot, upstreamModel: entry.id, priority: p });
                }
            }
            // Add affinity slot separately if it wasn't picked above
            if (affinitySlotId && entry.provider === 'opencode-free') {
                const affSlot = this.slots.find((s) => s.cfg.id === affinitySlotId && s.cfg.tier === 'opencode-free');
                if (affSlot && affSlot.status !== 'disabled') {
                    const alreadyHas = candidates.some((c) => c.slot.cfg.id === affinitySlotId);
                    if (!alreadyHas) {
                        candidates.unshift({ slot: affSlot, upstreamModel: entry.id, priority: 0 });
                    }
                }
            }
        }
        candidates.sort((a, b) => a.priority - b.priority);
        const seen = new Set();
        return candidates.filter((c) => {
            const key = `${c.slot.cfg.id}:${c.upstreamModel}`;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
    }
    shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }
    async callUpstream(slot, model, body, isStream, clientHeaders, sessionId) {
        const ua = USER_AGENTS[parseInt(slot.cfg.fingerprint.split('-')[1] || '1', 36) % USER_AGENTS.length];
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': ua,
            'X-Request-Id': crypto.randomUUID(),
            'X-Session-Fingerprint': slot.cfg.fingerprint,
        };
        if (slot.cfg.apiKey) {
            if (slot.cfg.tier === 'openrouter') {
                headers['Authorization'] = `Bearer ${slot.cfg.apiKey}`;
                headers['HTTP-Referer'] = 'https://opencode-bridge-telegram.local';
                headers['X-Title'] = 'OpenCode Bridge Telegram';
            }
            else {
                headers['Authorization'] = `Bearer ${slot.cfg.apiKey}`;
            }
        }
        // ── Forward OpenCode session headers (from OmniRoute's OpencodeExecutor.buildHeaders) ──
        if (clientHeaders) {
            const findHeader = (name) => {
                const val = clientHeaders[name];
                if (Array.isArray(val))
                    return val[0];
                return val;
            };
            const opencodeHeaderKeys = [
                'x-opencode-session',
                'x-opencode-request',
                'x-opencode-project',
                'x-opencode-client',
            ];
            for (const headerName of opencodeHeaderKeys) {
                const value = findHeader(headerName);
                if (value) {
                    headers[headerName] = value;
                }
            }
            // If no x-opencode-session but we have a sessionId (from x-session-id or generated),
            // map it onto x-opencode-session for upstream continuity.
            if (!headers['x-opencode-session'] && sessionId) {
                headers['x-opencode-session'] = sessionId;
                // Synthesize x-opencode-request if missing (OmniRoute pattern for custom-named providers)
                if (!headers['x-opencode-request']) {
                    headers['x-opencode-request'] = crypto.randomUUID();
                }
            }
        }
        const upstreamBody = { ...body, model, stream: isStream };
        // Strip any provider prefix (openai/, model-router/, etc.)
        if (upstreamBody.model && typeof upstreamBody.model === 'string' && upstreamBody.model.includes('/')) {
            const parts = upstreamBody.model.split('/');
            upstreamBody.model = parts.slice(1).join('/');
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 180_000);
        try {
            const res = await fetch(`${slot.cfg.baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(upstreamBody),
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                if (res.status === 429)
                    throw new Error(`Rate limited (429): ${text.slice(0, 200)}`);
                if (res.status === 401)
                    throw new Error(`Unauthorized (401): ${text.slice(0, 200)}`);
                if (res.status === 403)
                    throw new Error(`Forbidden (403): ${text.slice(0, 200)}`);
                if (res.status === 404)
                    throw new Error(`Model not found (404): ${text.slice(0, 200)}`);
                if (res.status >= 500)
                    throw new Error(`Upstream error (${res.status}): ${text.slice(0, 200)}`);
                throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
            }
            if (isStream) {
                return res;
            }
            return await res.json();
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async streamResponse(upstreamRes, res, req) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        if (!upstreamRes.body) {
            res.end();
            return { tokensOut: 0, content: '' };
        }
        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let contentLength = 0;
        let explicitTokensOut = 0;
        const contentParts = [];
        // Register close handler immediately to avoid race conditions
        req.on('close', () => {
            reader.cancel().catch(() => { });
        });
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                // Parse SSE events to count tokens and capture content
                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6);
                        if (dataStr === '[DONE]')
                            continue;
                        try {
                            const parsed = JSON.parse(dataStr);
                            const delta = parsed?.choices?.[0]?.delta?.content;
                            if (delta) {
                                contentLength += delta.length;
                                contentParts.push(delta);
                            }
                            if (parsed?.usage?.completion_tokens) {
                                explicitTokensOut = parsed.usage.completion_tokens;
                            }
                        }
                        catch { /* skip malformed SSE */ }
                    }
                }
                res.write(value);
                if (typeof res.flush === 'function')
                    res.flush();
            }
        }
        catch (err) {
            if (!res.writableEnded) {
                res.write(`data: {"error":"${err.message}"}\n\n`);
            }
        }
        finally {
            if (!res.writableEnded)
                res.end();
        }
        const tokensOut = explicitTokensOut > 0 ? explicitTokensOut : Math.ceil(contentLength / 4);
        const content = contentParts.join('').slice(0, 2000);
        return { tokensOut, content };
    }
    recordModelStat(model, tokensIn, tokensOut, success, ts) {
        const existing = this.modelStats.get(model) || { calls: 0, tokensIn: 0, tokensOut: 0, failures: 0, lastCallAt: null };
        existing.calls++;
        existing.tokensIn += tokensIn;
        existing.tokensOut += tokensOut;
        if (!success)
            existing.failures++;
        existing.lastCallAt = ts;
        this.modelStats.set(model, existing);
    }
    logRequest(entry) {
        this.requestLog.push(entry);
        if (this.requestLog.length > MAX_LOG_ENTRIES) {
            this.requestLog = this.requestLog.slice(-MAX_LOG_ENTRIES);
        }
    }
    handleResetSlot(req, res) {
        this.readBody(req).then((body) => {
            const slotId = body.slotId;
            const slot = this.slots.find((s) => s.cfg.id === slotId);
            if (!slot) {
                return this.respondJson(res, 404, { error: `Slot ${slotId} not found` });
            }
            slot.cooldownUntil = 0;
            slot.failureCount = 0;
            slot.status = 'active';
            slot.lastError = null;
            console.log(`[ModelRouter] Reset slot ${slotId}`);
            this.respondJson(res, 200, { ok: true, slotId });
        }).catch((err) => {
            this.respondJson(res, 400, { error: `Invalid request body: ${err.message}` });
        });
    }
    // ── Monitoring APIs ──────────────────────────────────────────────────
    getHealth() {
        const slotsActive = this.slots.filter((s) => s.status === 'active' && s.cooldownUntil <= Date.now()).length;
        return {
            status: slotsActive > 0 ? 'ok' : 'degraded',
            slots: this.slots.length,
            slotsActive,
            totalRequests: this.totalRequests,
            totalFailures: this.totalFailures,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
        };
    }
    getMonitoringHealth() {
        return {
            status: this.getHealth().status,
            system: {
                version: 'model-router/2.0',
                uptime: Math.floor((Date.now() - this.startTime) / 1000),
            },
            providers: {
                'opencode-free': {
                    slots: this.slots.filter((s) => s.cfg.tier === 'opencode-free').length,
                    active: this.slots.filter((s) => s.cfg.tier === 'opencode-free' && s.status === 'active' && s.cooldownUntil <= Date.now()).length,
                },
                'opencode-zen': {
                    slots: this.slots.filter((s) => s.cfg.tier === 'opencode-zen').length,
                    active: this.slots.filter((s) => s.cfg.tier === 'opencode-zen' && s.status === 'active' && s.cooldownUntil <= Date.now()).length,
                    configured: !!this.zenApiKey,
                },
                openrouter: {
                    slots: this.slots.filter((s) => s.cfg.tier === 'openrouter').length,
                    active: this.slots.filter((s) => s.cfg.tier === 'openrouter' && s.status === 'active' && s.cooldownUntil <= Date.now()).length,
                    configured: !!this.openrouterApiKey,
                },
            },
        };
    }
    getHealthMatrix() {
        const providers = {};
        for (const tier of ['opencode-free', 'opencode-zen', 'openrouter']) {
            const tierSlots = this.slots.filter((s) => s.cfg.tier === tier);
            providers[tier] = {
                status: tierSlots.some((s) => s.status === 'active' && s.cooldownUntil <= Date.now()) ? 'active' : 'down',
                totalSlots: tierSlots.length,
                activeSlots: tierSlots.filter((s) => s.status === 'active' && s.cooldownUntil <= Date.now()).length,
                cooldownSlots: tierSlots.filter((s) => s.cooldownUntil > Date.now()).length,
                circuitOpenSlots: tierSlots.filter((s) => s.status === 'circuit-open').length,
                totalCalls: tierSlots.reduce((sum, s) => sum + s.totalCalls, 0),
                totalFailures: tierSlots.reduce((sum, s) => sum + s.failureCount, 0),
            };
        }
        return { providers };
    }
    getAccounts() {
        const now = Date.now();
        return {
            total: this.slots.length,
            accounts: this.slots.map((s) => ({
                id: s.cfg.id,
                tier: s.cfg.tier,
                status: s.cooldownUntil > now ? 'cooldown' : s.status,
                failureCount: s.failureCount,
                totalCalls: s.totalCalls,
                tokensIn: s.totalTokensIn,
                tokensOut: s.totalTokensOut,
                lastCallAt: s.lastCallAt,
                lastError: s.lastError,
                lastLatencyMs: s.lastLatencyMs,
                cooldownRemainingMs: s.cooldownUntil > now ? s.cooldownUntil - now : 0,
            })),
            activeSessions: this.sessionManager.getActiveCount(),
        };
    }
    getStats() {
        const now = Date.now();
        const recentWindow = 5 * 60 * 1000;
        const recentLogs = this.requestLog.filter((l) => now - l.ts < recentWindow);
        const recentSuccess = recentLogs.filter((l) => l.status === 200);
        const recentFailure = recentLogs.filter((l) => l.status !== 200);
        return {
            totalRequests: this.totalRequests,
            totalFailures: this.totalFailures,
            successRate: this.totalRequests > 0 ? parseFloat(((this.totalRequests - this.totalFailures) / this.totalRequests * 100).toFixed(1)) : null,
            recent5m: {
                requests: recentLogs.length,
                successes: recentSuccess.length,
                failures: recentFailure.length,
                avgLatencyMs: recentSuccess.length > 0
                    ? Math.round(recentSuccess.reduce((s, l) => s + l.latencyMs, 0) / recentSuccess.length)
                    : null,
                tokensIn: recentSuccess.reduce((s, l) => s + l.tokensIn, 0),
                tokensOut: recentSuccess.reduce((s, l) => s + l.tokensOut, 0),
            },
            byTier: {
                'opencode-free': {
                    calls: this.slots.filter((s) => s.cfg.tier === 'opencode-free').reduce((sum, s) => sum + s.totalCalls, 0),
                    tokensIn: this.slots.filter((s) => s.cfg.tier === 'opencode-free').reduce((sum, s) => sum + s.totalTokensIn, 0),
                    tokensOut: this.slots.filter((s) => s.cfg.tier === 'opencode-free').reduce((sum, s) => sum + s.totalTokensOut, 0),
                },
                'opencode-zen': {
                    calls: this.slots.filter((s) => s.cfg.tier === 'opencode-zen').reduce((sum, s) => sum + s.totalCalls, 0),
                    tokensIn: this.slots.filter((s) => s.cfg.tier === 'opencode-zen').reduce((sum, s) => sum + s.totalTokensIn, 0),
                    tokensOut: this.slots.filter((s) => s.cfg.tier === 'opencode-zen').reduce((sum, s) => sum + s.totalTokensOut, 0),
                },
                openrouter: {
                    calls: this.slots.filter((s) => s.cfg.tier === 'openrouter').reduce((sum, s) => sum + s.totalCalls, 0),
                    tokensIn: this.slots.filter((s) => s.cfg.tier === 'openrouter').reduce((sum, s) => sum + s.totalTokensIn, 0),
                    tokensOut: this.slots.filter((s) => s.cfg.tier === 'openrouter').reduce((sum, s) => sum + s.totalTokensOut, 0),
                },
            },
            perModel: Object.fromEntries(this.modelStats.entries()),
            uptime: Math.floor((now - this.startTime) / 1000),
        };
    }
    getLogs() {
        return {
            logs: [...this.requestLog].reverse().slice(0, 50),
        };
    }
    getModelDetails() {
        return { tiers: TIER_MODELS, aliases: MODEL_ALIASES, stats: Object.fromEntries(this.modelStats.entries()) };
    }
    /**
     * Push a model call event to the dashboard telemetry store.
     */
    pushTelemetry(model, slot, tokensIn, tokensOut, sessionId, prompt, response) {
        const telemetry = getTelemetryClient();
        telemetry.logCall({
            type: 'model.completed',
            ts: new Date().toISOString(),
            provider: slot.cfg.tier,
            modelId: model,
            sessionId: sessionId || slot.cfg.id,
            prompt: prompt?.slice(0, 2000) || '',
            response: response?.slice(0, 2000) || '',
            data: {
                promptCache: {
                    lastCallUsage: {
                        input: tokensIn,
                        output: tokensOut,
                        totalTokens: tokensIn + tokensOut,
                        cost: { total: 0 },
                    },
                },
                promptError: null,
                terminalError: null,
                timedOut: false,
            },
        });
    }
    /**
     * Extract prompt text from the request body for logging.
     */
    extractPrompt(body) {
        if (!body || typeof body !== 'object')
            return '';
        const messages = body.messages || body.input || [];
        if (!Array.isArray(messages))
            return '';
        return messages
            .map((m) => {
            const role = m.role || 'unknown';
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            return `${role}: ${content}`;
        })
            .join('\n');
    }
    // ── Utilities ────────────────────────────────────────────────────────
    readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString()));
                }
                catch (e) {
                    reject(new Error('Invalid JSON body'));
                }
            });
            req.on('error', reject);
        });
    }
    respondJson(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }
}
