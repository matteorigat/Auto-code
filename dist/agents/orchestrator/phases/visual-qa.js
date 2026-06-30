import { AgentRuntime } from '../../runtime.js';
import { TierSelector } from '../../../src/core/tier-selector.js';
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
            updateStatus({
                phase: 'VISUAL_QA',
                taskTitle: `[${task.id}] Launching browser & capturing screenshot...`,
                taskId: task.id,
            });
            log(`[VISUAL_QA] Attempting to screenshot UI for ${taskId}`);
            let browser = null;
            try {
                browser = (await puppeteerDefault.launch({
                    headless: 'new',
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                }));
                const page = await browser.newPage();
                await page.goto('http://localhost:3000', { waitUntil: 'networkidle0', timeout: 5000 });
                screenshotBase64 = await page.screenshot({ encoding: 'base64', fullPage: true });
            }
            catch (e) {
                log(`[VISUAL_QA] Could not capture screenshot: ${e.message}`);
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
