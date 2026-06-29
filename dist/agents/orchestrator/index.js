#!/usr/bin/env node
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { getDurableState } from '../../src/core/durable-state.js';
import { TaskManager } from '../../src/core/task-manager.js';
import { TelegramChannel } from '../../src/bot/telegram-channel.js';
import { MemoryManager } from '../../src/core/memory-manager.js';
import { Safety } from '../../src/core/safety.js';
import NotionAdapter from '../../src/core/notion-adapter.js';
import { EventStream } from '../../src/core/event-stream.js';
import { TelemetryClient } from '../../src/dashboard/telemetry-client.js';
import config from '../../src/config/index.js';
async function main() {
    const args = process.argv.slice(2);
    const projectPath = args[0];
    if (!projectPath) {
        console.error('Usage: node agents/orchestrator/index.js <project-path>');
        process.exit(1);
    }
    const stream = new EventStream(projectPath);
    const state = getDurableState(projectPath, stream);
    const checkpoint = await state.load();
    const notion = new NotionAdapter({
        token: config.notion.apiToken,
        databaseId: config.notion.databaseId,
        pageId: config.notion.pageId,
    });
    const telegram = new TelegramChannel({
        botToken: config.telegram.botToken,
        chatId: config.system.chatId,
    });
    const tasks = new TaskManager({ projectPath, notionAdapter: notion });
    const memory = new MemoryManager(projectPath, stream);
    const safety = new Safety(projectPath);
    const telemetry = new TelemetryClient();
    await telegram.initPinned();
    const context = {
        projectPath,
        state,
        notion,
        telegram,
        tasks,
        memory,
        safety,
        stream,
        log: (msg) => {
            const time = new Date().toISOString().slice(11, 19);
            console.log(`[${time}] ${msg}`);
            memory.appendEvent('log', { message: msg });
            telemetry.info('orchestrator', msg);
        },
        updateStatus: (delta) => {
            telegram.updateStatus(delta);
            try {
                const statePath = join(projectPath, '.hydra', 'loop-state.json');
                writeFileSync(statePath, JSON.stringify(telegram._status, null, 2));
            }
            catch (e) {
                console.error('Ignored error:', e.message);
            }
        },
    };
    const { handleIdle } = await import('./phases/idle.js');
    const { handlePlan } = await import('./phases/plan.js');
    const { handleExec } = await import('./phases/exec.js');
    const { handleQa } = await import('./phases/qa.js');
    const { handleFix } = await import('./phases/fix.js');
    const { handleSwarm } = await import('./phases/swarm.js');
    const { handleVisualQa } = await import('./phases/visual-qa.js');
    const { handleCommit } = await import('./phases/commit.js');
    const { handleReflect } = await import('./phases/reflect.js');
    const { handleDiscover } = await import('./phases/discover.js');
    const { handleSync } = await import('./phases/sync.js');
    const { handleWaitHuman } = await import('./phases/wait-human.js');
    const phaseHandlers = new Map([
        ['IDLE', handleIdle],
        ['PLAN', handlePlan],
        ['EXEC', handleExec],
        ['QA', handleQa],
        ['VISUAL_QA', handleVisualQa],
        ['FIX', handleFix],
        ['SWARM', handleSwarm],
        ['COMMIT', handleCommit],
        ['REFLECT', handleReflect],
        ['SYNC', handleSync],
        ['DISCOVER', handleDiscover],
        ['WAIT_HUMAN', handleWaitHuman],
    ]);
    let transitioning = false;
    const transitionQueue = [];
    const processQueue = async () => {
        if (transitioning)
            return;
        transitioning = true;
        try {
            while (transitionQueue.length > 0) {
                const payload = transitionQueue.shift();
                const currentState = await state.load();
                context.log(`[EventStream] Transitioning to phase: ${payload.phase}`);
                telemetry.emit('phase.transition', 'orchestrator', `Phase: ${payload.phase}`, {
                    data: {
                        from: currentState.phase || 'IDLE',
                        to: payload.phase,
                        taskId: currentState.currentTaskId || null,
                        projectSlug: projectPath.split('/').pop(),
                    },
                });
                await state.transition(payload.phase, payload.stateUpdates);
                const handler = phaseHandlers.get(payload.phase);
                if (handler) {
                    try {
                        await handler(context);
                    }
                    catch (e) {
                        context.log(`Error in phase ${payload.phase}: ${e.stack || e.message}`);
                    }
                }
                else {
                    context.log(`Unknown phase: ${payload.phase}`);
                }
            }
        }
        finally {
            transitioning = false;
        }
    };
    stream.on('System', (event) => {
        const payload = event.payload;
        if (payload?.action === 'PhaseChange') {
            if (transitioning) {
                context.log(`[EventStream] Transition blocked — queuing phase: ${payload.phase}`);
            }
            transitionQueue.push(payload);
            setImmediate(processQueue);
        }
    });
    await tasks.loadTasks();
    context.log(`🔥 Orchestrator starting — ${projectPath}`);
    context.log(`Checkpoint phase: ${checkpoint.phase || 'IDLE'}`);
    stream.emit('System', 'system', { action: 'PhaseChange', phase: checkpoint.phase || 'IDLE' });
    if (process.send) {
        process.on('message', (msg) => {
            const m = msg;
            if (m.action === 'dashboard_cmd') {
                if (m.cmd === 'pause') {
                    context.log('⏸️ Loop paused by Web Dashboard (IPC)');
                    stream.emit('System', 'system', {
                        action: 'PhaseChange',
                        phase: 'WAIT_HUMAN',
                        stateUpdates: { reason: 'Paused by dashboard' },
                    });
                }
                else if (m.cmd === 'resume') {
                    context.log('▶️ Loop resumed by Web Dashboard (IPC)');
                    stream.emit('System', 'system', { action: 'PhaseChange', phase: 'IDLE' });
                }
            }
        });
    }
}
main().catch(console.error);
