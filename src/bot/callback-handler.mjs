import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import config from '../config/index.mjs';

export function createCallbackHandler(bot, loopManager) {
  const projectsRoot = join(config.system.rootDir, '..');

  return async function handleCallback(cb) {
    const data = cb.data;
    const chatId = cb.message?.chat.id;
    const msgId = cb.message?.message_id;
    const userId = cb.from?.id;

    if (!userId || !config.telegram.allowedUserIds.includes(userId)) {
      await bot
        .callApi('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: '\u26D4 Unauthorized',
          show_alert: true,
        })
        .catch(() => {});
      return;
    }

    /* Acknowledge callback immediately */
    await bot.callApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

    if (data.startsWith('hydra:pause')) {
      loopManager.sendCommand('pause');
      await bot.updateMessage(
        chatId,
        msgId,
        `\u23F8 *Loop Paused*\n\nUse /loop resume to continue.`,
        {},
      );
      return;
    }

    if (
      data === 'hydra:resume' ||
      data.startsWith('hydra:approve:') ||
      data.startsWith('hydra:reject:')
    ) {
      const currentProjectPath = loopManager.currentProjectPath || join(projectsRoot, 'loop');

      if (!loopManager.childProc) {
        await bot.send(chatId, '\u25B6\uFE0F Loop is not running. Starting it...');
        loopManager.startLoop(chatId, null);
      } else {
        const signalPath = join(currentProjectPath, '.hydra', 'resume-signal.json');
        try {
          const dir = dirname(signalPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(signalPath, JSON.stringify({ action: 'resume', data }), 'utf-8');

          /* Show resolved state by editing the callback message */
          const actionLabel = data.startsWith('hydra:approve')
            ? '\u2705 Approved'
            : data.startsWith('hydra:reject')
              ? '\u274C Rejected'
              : '\u25B6\uFE0F Resume signal sent';
          await bot.updateMessage(
            chatId,
            msgId,
            `~~${cb.message?.text || 'Human Gate'}~~\n\n_${actionLabel}_`,
            { reply_markup: bot.inlineKeyboard([]) },
          );
        } catch (e) {
          await bot.send(chatId, `\u274C Error: ${e.message}`);
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
      await bot.updateMessage(
        chatId,
        msgId,
        `~~${cb.message?.text || 'Human Gate'}~~\n\n_\u26D4 Aborted_`,
        { reply_markup: bot.inlineKeyboard([]) },
      );
    }
  };
}
