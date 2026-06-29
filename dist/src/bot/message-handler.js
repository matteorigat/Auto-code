import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import config from '../config/index.js';
import { PROJECTS } from '../core/projects.js';
export function createMessageHandler(bot, loopManager, opencodeClient, wizard, sessionManager) {
    const projectsRoot = join(config.system.rootDir, '..');
    return async function handleMessage(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from?.id;
        const text = msg.text?.trim();
        if (!text || !userId)
            return;
        if (!config.telegram.allowedUserIds.includes(userId)) {
            await bot.send(chatId, '⛔ Unauthorized.');
            return;
        }
        const st = bot.getState(chatId);
        if (msg.message_id)
            bot.persistMsgId(chatId, msg.message_id, 'user');
        const [cmd, ...rest] = text.split(/\s+/);
        if (cmd === '/loop') {
            const sub = (rest[0] || '').toLowerCase();
            if (!sub || sub === 'start') {
                if (loopManager.childProc) {
                    await bot.send(chatId, 'ℹ️ Loop is already running.');
                    return;
                }
                await bot.send(chatId, '▶️ Starting Hydra Loop...');
                await loopManager.startLoop(chatId, st.project || undefined);
                return;
            }
            if (sub === 'resume') {
                await handleResume(chatId, bot, loopManager, projectsRoot);
                return;
            }
            if (sub === 'pause') {
                loopManager.sendCommand('pause');
                await bot.send(chatId, '⏸ Pause signal sent to Loop.');
                return;
            }
            if (sub === 'kill' || sub === 'stop') {
                loopManager.shouldBeRunning = false;
                if (loopManager.childProc) {
                    loopManager.childProc.kill('SIGTERM');
                    loopManager.childProc = null;
                }
                await bot.send(chatId, '⛔ Loop killed.');
                return;
            }
            if (sub === 'status') {
                const running = loopManager.childProc ? '✅ Running' : '❌ Stopped';
                const phase = loopManager.currentPhase || 'N/A';
                await bot.send(chatId, `*Loop Status*\n\n• State: ${running}\n• Phase: \`${phase}\`\n• Project: \`${st.project || 'bridge'}\``);
                return;
            }
        }
        if (cmd === '/resume') {
            await handleResume(chatId, bot, loopManager, projectsRoot);
            return;
        }
        if (cmd === '/reset' || cmd === '/cleanup') {
            await handleCleanup(chatId, bot, projectsRoot, st);
            return;
        }
        if (cmd === '/new') {
            wizard.startWizard(st);
            await bot.send(chatId, '🆕 *New session*\n\n1️⃣ Loop\n2️⃣ Chat\n3️⃣ Create project\n\nReply with 1, 2, or 3.');
            return;
        }
        if (st.wizard) {
            await wizard.handleWizard(chatId, text, st);
            return;
        }
        if (cmd === '/start' || cmd === '/help') {
            await bot.send(chatId, [
                '*OPencode Modular Bridge*',
                '',
                'Commands:',
                '• `/new` — Start a new session (Loop / Chat / Create project)',
                '• `/loop start` — Start the Hydra Loop',
                '• `/loop resume` — Resume blocked loop',
                '• `/loop pause` — Pause the loop',
                '• `/loop status` — Check loop state',
                '• `/loop kill` — Stop the loop',
                '• `/reset` — Clean up state files and messages',
                '• `/help` — Show this message',
                '',
                'Or just type a message to chat with the active session.',
            ].join('\n'));
            return;
        }
        if (st.sessionId) {
            bot.startTyping(chatId);
            try {
                const result = (await opencodeClient.sendPrompt(st.sessionId, text, PROJECTS[st.project]?.path));
                const replyText = result?.parts
                    ?.map((p) => p.text || '')
                    .join('\n')
                    .trim();
                if (replyText) {
                    await bot.send(chatId, `✅ *Response:*\n\n${replyText}`);
                }
                else {
                    await bot.send(chatId, '✅ *Completed*');
                }
            }
            catch (err) {
                await bot.send(chatId, `❌ ${err.message}`);
            }
            bot.stopTyping(chatId);
        }
        else {
            await bot.send(chatId, 'No active session. Use /new to start one, or /help for commands.');
        }
    };
}
async function handleResume(chatId, bot, loopManager, projectsRoot) {
    const currentProjectPath = loopManager.currentProjectPath || join(projectsRoot, 'loop');
    if (!loopManager.childProc) {
        await bot.send(chatId, '▶️ Loop is not running. Starting it...');
        await loopManager.startLoop(chatId);
        return;
    }
    const signalPath = join(currentProjectPath, '.hydra', 'resume-signal.json');
    try {
        const d = dirname(signalPath);
        if (!existsSync(d))
            mkdirSync(d, { recursive: true });
        writeFileSync(signalPath, JSON.stringify({ action: 'resume' }), 'utf-8');
        await bot.send(chatId, '▶️ Sending resume signal to Loop...');
    }
    catch {
        await bot.send(chatId, '❌ Error during resume');
    }
}
async function handleCleanup(chatId, bot, projectsRoot, st) {
    await bot.send(chatId, '🧹 *Cleaning up...*');
    try {
        await bot.deleteAllBotMessages(chatId);
        const loopDir = join(projectsRoot, 'loop');
        if (existsSync(loopDir)) {
            rmSync(loopDir, { recursive: true, force: true });
        }
        const hydraDir = join(config.system.rootDir, '.hydra');
        const filesToClean = [
            'chat-state.json',
            'loop-project.json',
            'loop-msg-ids.json',
            'stopped',
            'loop-checkpoint.json',
            'loop-checkpoint.json.bak',
            'event-stream.jsonl',
            'cost-log.json',
        ];
        let filesCleaned = 0;
        for (const f of filesToClean) {
            const p = join(hydraDir, f);
            if (existsSync(p)) {
                rmSync(p, { force: true });
                filesCleaned++;
            }
        }
        st.project = 'bridge';
        st.model = null;
        st.sessionId = null;
        st.wizard = null;
        await bot.send(chatId, `✅ *Clean up completed!*\n\n- State files cleaned: \`${filesCleaned}\`\n- Chat messages cleaned\n- Session state reset.\n\nUse /new to start over.`);
    }
    catch {
        await bot.send(chatId, '❌ *Error during clean up*');
    }
}
