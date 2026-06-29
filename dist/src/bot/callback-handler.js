import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import config from '../config/index.js';
export function createCallbackHandler(bot, loopManager) {
    const projectsRoot = join(config.system.rootDir, '..');
    return async function handleCallback(cb) {
        const data = cb.data || '';
        const chatId = cb.message?.chat.id;
        const msgId = cb.message?.message_id;
        const userId = cb.from?.id;
        if (!userId || !chatId || !msgId || !config.telegram.allowedUserIds.includes(userId)) {
            await bot
                .callApi('answerCallbackQuery', {
                callback_query_id: cb.id,
                text: '⛔ Unauthorized',
                show_alert: true,
            })
                .catch(() => { });
            return;
        }
        await bot.callApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => { });
        if (data.startsWith('hydra:pause')) {
            loopManager.sendCommand('pause');
            await bot.updateMessage(chatId, msgId, '⏸ *Loop Paused*\n\nUse /loop resume to continue.', {});
            return;
        }
        if (data === 'hydra:resume' ||
            data.startsWith('hydra:approve:') ||
            data.startsWith('hydra:reject:')) {
            const currentProjectPath = loopManager.currentProjectPath || join(projectsRoot, 'loop');
            if (!loopManager.childProc) {
                await bot.send(chatId, '▶️ Loop is not running. Starting it...');
                loopManager.startLoop(chatId);
            }
            else {
                const signalPath = join(currentProjectPath, '.hydra', 'resume-signal.json');
                try {
                    const d = dirname(signalPath);
                    if (!existsSync(d))
                        mkdirSync(d, { recursive: true });
                    writeFileSync(signalPath, JSON.stringify({ action: 'resume', data }), 'utf-8');
                    const actionLabel = data.startsWith('hydra:approve')
                        ? '✅ Approved'
                        : data.startsWith('hydra:reject')
                            ? '❌ Rejected'
                            : '▶️ Resume signal sent';
                    await bot.updateMessage(chatId, msgId, `~~${cb.message?.text || 'Human Gate'}~~\n\n_${actionLabel}_`, { reply_markup: bot.inlineKeyboard([]) });
                }
                catch (err) {
                    await bot.send(chatId, `❌ Error: ${err.message}`);
                }
            }
            return;
        }
        if (data.startsWith('hydra:abort:')) {
            loopManager.shouldBeRunning = false;
            if (loopManager.childProc) {
                loopManager.childProc.kill('SIGTERM');
                loopManager.childProc = null;
            }
            await bot.updateMessage(chatId, msgId, `~~${cb.message?.text || 'Human Gate'}~~\n\n_⛔ Aborted_`, { reply_markup: bot.inlineKeyboard([]) });
        }
    };
}
