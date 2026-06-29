import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDockerController } from '../../src/services/docker-sandbox.js';
import config from '../../src/config/index.js';
import { NetworkTimeoutError, AppError } from '../../src/core/errors.js';
const OC_URL = config.opencode.url;
export function now() {
    return new Date().toISOString();
}
export function logErr(projectPath, ctx, err) {
    const logFile = join(projectPath, '.hydra', 'runtime-error.log');
    try {
        const entry = `[${now()}] [${ctx}] ${err?.message || String(err)}\n${err?.stack || ''}\n---\n`;
        appendFileSync(logFile, entry);
    }
    catch (e) {
        console.error('Ignored error:', e.message);
    }
    console.error(`[runtime ${ctx}]`, err?.message || err);
}
export async function fetchWithRetry(url, options, projectPath, ctx, retries = 3, delay = 10000) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.status === 429 || res.status >= 500) {
                if (i === retries - 1)
                    return res;
                const backoffMs = Math.min(60000 * (i + 1), 120000);
                logErr(projectPath, `fetchWithRetry.${ctx}`, new AppError(`HTTP ${res.status}, retrying ${i + 1}/${retries} in ${backoffMs}ms...`, res.status, 'HTTP_RETRY'));
                await new Promise((r) => setTimeout(r, backoffMs));
                continue;
            }
            return res;
        }
        catch (err) {
            if (i === retries - 1)
                throw new NetworkTimeoutError(`${err.message || err}, retries exhausted`);
            logErr(projectPath, `fetchWithRetry.${ctx}`, new NetworkTimeoutError(`${err.message || err}, retrying ${i + 1}/${retries} in ${delay}ms...`));
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw new Error('Unreachable');
}
export async function getOcUrl(projectPath, taskId) {
    try {
        const controller = getDockerController(projectPath);
        if (taskId) {
            await controller.startSandbox(taskId, projectPath);
            const container = controller.containers.get(taskId);
            if (container && container.ip) {
                return `http://${container.ip}:5000`;
            }
        }
    }
    catch (_e) {
        // Fallback
    }
    return OC_URL;
}
export async function apiCall(method, path, projectPath, taskId, opts = {}, safety) {
    if (safety?.isCircuitOpen?.()) {
        const err = new AppError(`[AgentRuntime] Circuit breaker open — skipping ${method} ${path}`, 503, 'CIRCUIT_OPEN');
        logErr(projectPath, `API.${method}.${path}`, err);
        throw err;
    }
    const baseUrl = await getOcUrl(projectPath, taskId);
    const url = `${baseUrl}${path}`;
    try {
        const res = await fetchWithRetry(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-opencode-directory': projectPath,
                ...(opts.headers || {}),
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        }, projectPath, `API.${method}`);
        if (!res.ok) {
            safety?.recordApiFailure?.(res.status);
            const text = await res.text().catch(() => '');
            const err = new AppError(`[AgentRuntime] ${method} ${path} → HTTP ${res.status}\nBody: ${text.slice(0, 500)}`, res.status, 'HTTP_ERROR');
            logErr(projectPath, `API.${method}.${path}`, err);
            throw err;
        }
        safety?.recordApiSuccess?.();
        return res.json().catch(() => ({}));
    }
    catch (fetchErr) {
        const err = new NetworkTimeoutError(`[AgentRuntime] ${method} ${path} → ${fetchErr.message || fetchErr}\n(ProjectPath: ${projectPath})`);
        logErr(projectPath, `API.network.${method}.${path}`, err);
        throw err;
    }
}
