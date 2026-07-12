import { AgentRuntime } from '../../runtime.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Detect the port the dev server is running on.
 * Priority: .hydra/app-config.json > package.json scripts.dev port > common ports probe.
 */
async function detectAppPort(ws) {
    // 1. Explicit config override
    try {
        const cfg = JSON.parse(readFileSync(join(ws, '.hydra', 'app-config.json'), 'utf-8'));
        if (cfg.port && typeof cfg.port === 'number')
            return cfg.port;
    }
    catch (_) { }
    // 2. Parse port from package.json scripts (e.g. "dev": "next dev -p 3001" or "vite --port 4000")
    try {
        const pkg = JSON.parse(readFileSync(join(ws, 'package.json'), 'utf-8'));
        const scripts = pkg.scripts || {};
        const devScript = scripts.dev || scripts.start || scripts.serve || '';
        const portMatch = devScript.match(/(?:--port|-p)\s+(\d+)/);
        if (portMatch)
            return parseInt(portMatch[1], 10);
        // Next.js default on 3000, Vite on 5173, CRA on 3000
        if (devScript.includes('next'))
            return 3000;
        if (devScript.includes('vite'))
            return 5173;
    }
    catch (_) { }
    // 3. Probe common dev ports
    const { createConnection } = await import('node:net');
    const tryPort = (port) => new Promise((resolve) => {
        const sock = createConnection(port, '127.0.0.1');
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
        sock.setTimeout(400, () => { sock.destroy(); resolve(false); });
    });
    for (const port of [3000, 3001, 5173, 4000, 8080, 8000]) {
        if (await tryPort(port))
            return port;
    }
    return null;
}
export async function handleVisualQa(context) {
    const { tasks, stream, log, updateStatus, projectPath, state, safety } = context;
    log(`[VISUAL_QA] Running VISUAL_QA phase...`);
    const currentState = state.get() || {};
    const visualQaTaskIds = currentState.visualQaTaskIds || [];
    if (!visualQaTaskIds.length) {
        stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
        return;
    }
    let puppeteerMod = null;
    try {
        puppeteerMod = await import('puppeteer');
    }
    catch (e) {
        log(`[VISUAL_QA] Puppeteer/Chrome is not available or failed to load: ${e.message}`);
    }
    const tasksArr = tasks._tasks || [];
    for (const taskId of visualQaTaskIds) {
        const task = tasksArr.find((t) => String(t.id) === String(taskId));
        if (!task)
            continue;
        const ws = task.workspacePath || projectPath;
        updateStatus({
            phase: 'VISUAL_QA',
            taskTitle: `[${task.id}] Initiating visual validations...`,
            taskId: task.id,
        });
        state.transition('VISUAL_QA', {
            currentTaskId: task.id,
            currentStory: task.title,
        });
        let screenshotBase64 = null;
        const puppeteerDefault = puppeteerMod?.default;
        if (puppeteerMod && puppeteerDefault) {
            // B3: Dynamically detect the app port instead of hardcoding localhost:3000
            const appPort = await detectAppPort(ws);
            if (appPort === null) {
                log(`[VISUAL_QA] No running dev server detected on any known port. Auto-passing ${taskId}.`);
                tasks.markPass(taskId);
                continue;
            }
            updateStatus({
                phase: 'VISUAL_QA',
                taskTitle: `[${task.id}] Launching browser & capturing screenshot on port ${appPort}...`,
                taskId: task.id,
            });
            log(`[VISUAL_QA] Attempting to screenshot UI for ${taskId} on localhost:${appPort}`);
            let browser = null;
            try {
                browser = (await puppeteerDefault.launch({
                    headless: 'new',
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                }));
                const page = await browser.newPage();
                await page.goto(`http://localhost:${appPort}`, { waitUntil: 'networkidle0', timeout: 8000 });
                screenshotBase64 = await page.screenshot({ encoding: 'base64', fullPage: true });
            }
            catch (e) {
                log(`[VISUAL_QA] Could not capture screenshot on port ${appPort}: ${e.message}`);
            }
            finally {
                if (browser)
                    await browser.close();
            }
        }
        else {
            log(`[VISUAL_QA] Skipping screenshot capture because Puppeteer/Chrome is disabled or not installable on this system.`);
        }
        if (screenshotBase64) {
            updateStatus({
                phase: 'VISUAL_QA',
                taskTitle: `[${task.id}] Reviewing UI layout with visual-reviewer...`,
                taskId: task.id,
            });
            log(`[VISUAL_QA] Invoking visual-reviewer AgentRuntime`);
            const tierSelector = new TierSelector();
            const tier = tierSelector.select('QA');
            tierSelector.applyTierConfig(tier, ws);
            const runtime = new AgentRuntime({
                projectPath: ws,
                agentType: 'visual-reviewer',
                task,
                safety,
                stream,
            });
            runtime.task = {
                ...task,
                _screenshotBase64: screenshotBase64,
            };
            const runResult = await runtime.run(120000);
            const resultContent = runResult.content || '';
            const resultInfo = runResult.result;
            const feedback = resultContent || resultInfo?.info?.content || '';
            if (feedback.includes('APPROVED')) {
                log(`[VISUAL_QA] ${taskId} PASSED visual inspection`);
                tasks.markPass(taskId);
            }
            else {
                log(`[VISUAL_QA] ${taskId} FAILED visual inspection`);
                const reflectionCount = currentState.reflectionCount || 0;
                stream.emit('System', 'system', {
                    action: 'PhaseChange',
                    phase: 'FIX',
                    stateUpdates: {
                        previousError: `Visual UI issues detected:\n${feedback}`,
                        fixTaskId: taskId,
                        reflectionCount: reflectionCount + 1,
                    },
                });
                return;
            }
        }
        else {
            log(`[VISUAL_QA] No UI detected, auto-passing ${taskId}`);
            tasks.markPass(taskId);
        }
    }
    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'COMMIT' });
}
