#!/usr/bin/env node
import { join } from 'node:path';
import config from './config/index.js';
import { getAppBus } from './core/app-bus.js';
import { ProcessManager } from './services/process-manager.js';
import { BridgeBot } from './bot/telegram-bot.js';
import { OpenCodeClient } from './core/opencode-client.js';
import { WizardFSM } from './bot/wizard-fsm.js';
import { PROJECTS } from './core/projects.js';
import { LoopManager } from './services/loop-manager.js';
import { PollingManager } from './services/polling.js';
import { createMessageHandler } from './bot/message-handler.js';
import { createCallbackHandler } from './bot/callback-handler.js';
import { getTelemetryClient } from './dashboard/telemetry-client.js';
import { DashboardServer } from './dashboard/server.js';
const telemetry = getTelemetryClient();
const processManager = new ProcessManager(config.system.rootDir);
const opencodeClient = new OpenCodeClient(processManager);
const statePath = join(config.system.rootDir, '.hydra', 'chat-state.json');
const bot = new BridgeBot(config.telegram.botToken, statePath, config.telegram.allowedUserIds);
const loopManager = new LoopManager(bot);
// Forward opencode usage events → dashboard metrics via HTTP
opencodeClient.eventBus.on('event', (evt) => {
    if (evt.type === 'message.updated' && evt.properties?.info) {
        const info = evt.properties.info;
        const modelStr = info.model || '';
        const firstSlash = modelStr.indexOf('/');
        const provider = firstSlash >= 0 ? modelStr.slice(0, firstSlash) : 'opencode';
        const modelId = firstSlash >= 0 ? modelStr.slice(firstSlash + 1) : modelStr;
        const usage = info.usage || {};
        const inp = usage.input || usage.promptTokens || 0;
        const out = usage.output || usage.completionTokens || 0;
        const err = info.error || null;
        telemetry.logCall({
            type: 'model.completed',
            ts: info.time?.completed || new Date().toISOString(),
            provider,
            modelId,
            sessionId: evt.sessionId || evt.properties?.sessionId || '',
            data: {
                promptCache: {
                    lastCallUsage: {
                        input: inp,
                        output: out,
                        totalTokens: inp + out,
                        cost: { total: usage.cost || 0 },
                    },
                },
                promptError: err,
                terminalError: null,
                timedOut: false,
            },
        });
    }
});
// Periodically send health status to dashboard
const HEALTH_PING_INTERVAL = setInterval(() => {
    telemetry.healthPing({
        omniroute: processManager.omnirouteProc ? { running: true } : { running: false },
        opencode: processManager.healthOk
            ? { running: true }
            : { running: false, restartDelay: processManager.opencodeRestartDelay },
        loop: loopManager.childProc
            ? { running: true, phase: loopManager.currentPhase }
            : { running: false },
        bridge: { uptime: Math.floor((Date.now() - processManager.startupTime) / 1000) },
    });
}, 5000);
HEALTH_PING_INTERVAL.unref();
const sessionManager = {
    createChatSession: async (chatId, projectKey, st) => {
        try {
            const proj = PROJECTS[projectKey];
            if (!proj)
                throw new Error(`Project ${projectKey} not found`);
            const session = await opencodeClient.createSession(proj.path);
            st.sessionId = session.id;
            opencodeClient.subscribeEvents(proj.path, () => bot.stopAllTyping());
            await bot.send(chatId, `✅ Session \`${session.id.substring(0, 8)}…\` opened on \`${projectKey}\`.\nYou can now write a task directly.`);
        }
        catch (e) {
            await bot.send(chatId, `❌ ${e instanceof Error ? e.message : String(e)}`);
        }
    },
};
const wizard = new WizardFSM(bot, loopManager, sessionManager);
const handleMessage = createMessageHandler(bot, loopManager, opencodeClient, wizard, sessionManager);
const handleCallback = createCallbackHandler(bot, loopManager);
const pollingManager = new PollingManager(bot, handleMessage, handleCallback);
console.log('Starting modular bridge...');
processManager.startOmniRoute();
processManager.startOpencode();
processManager.startHealthServer(() => !!loopManager.childProc);
const dashboardServer = new DashboardServer(config.dashboard?.port || 8081, {
    processManager,
    loopManager,
    bot,
});
dashboardServer.start();
(async function main() {
    // Wire AppBus to Telemetry
    const bus = getAppBus();
    const telemetry = getTelemetryClient();
    bus.on('telemetry', ({ type, source, message, data }) => {
        telemetry.emit(type, source, message, data);
    });
    const projectPath = process.argv[2] || process.cwd();
    const ok = await processManager.waitForHealth(10);
    if (ok) {
        console.log('✅ opencode pronto. Starting poll...');
    }
    else {
        console.warn('⚠️ opencode health check non riuscito. Polling partira comunque tra 5s...');
        await new Promise((r) => setTimeout(r, 5000));
    }
    pollingManager.poll();
})();
async function gracefulShutdown(signal) {
    if (pollingManager.isShuttingDown)
        return;
    console.log(`\n[SHUTDOWN] Received ${signal}. Starting graceful shutdown...`);
    clearInterval(HEALTH_PING_INTERVAL);
    pollingManager.stop();
    // Set safety timeout
    setTimeout(() => {
        console.error('[SHUTDOWN] Force exit after 10s timeout.');
        process.exit(1);
    }, 10000).unref();
    try {
        dashboardServer.stop();
        processManager.stopAll();
        if (loopManager.childProc) {
            loopManager.childProc.kill('SIGTERM');
        }
        bot.persist();
        console.log('[SHUTDOWN] All components stopped successfully.');
        process.exit(0);
    }
    catch (err) {
        console.error('[SHUTDOWN] Error during shutdown:', err);
        process.exit(1);
    }
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
