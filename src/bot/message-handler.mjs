import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import config from '../config/index.mjs';
import { PROJECTS } from '../core/projects.mjs';

export function createMessageHandler(bot, loopManager, opencodeClient, wizard, sessionManager) {
  const projectsRoot = join(config.system.rootDir, '..');

  return async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text?.trim();
    if (!text || !userId) return;

    if (!config.telegram.allowedUserIds.includes(userId)) {
      return bot.send(chatId, '\u26D4 Unauthorized.');
    }

    const st = bot.getState(chatId);
    if (msg.message_id) bot.persistMsgId(chatId, msg.message_id, 'user');

    const [cmd, ...rest] = text.split(/\s+/);
    const args = rest.join(' ');

    /* /loop subcommands */
    if (cmd === '/loop') {
      const sub = (rest[0] || '').toLowerCase();
      if (sub === 'start' || sub === '') {
        if (loopManager.childProc) {
          return bot.send(chatId, '\u2139\uFE0F Loop is already running.');
        }
        await bot.send(chatId, '\u25B6\uFE0F Starting Hydra Loop...');
        return loopManager.startLoop(chatId, st.project || null);
      }
      if (sub === 'resume') {
        const currentProjectPath = loopManager.currentProjectPath || join(projectsRoot, 'loop');
        if (!loopManager.childProc) {
          await bot.send(chatId, '\u25B6\uFE0F Loop is not running. Starting it...');
          return loopManager.startLoop(chatId, st.project || null);
        }
        const signalPath = join(currentProjectPath, '.hydra', 'resume-signal.json');
        try {
          const dir = dirname(signalPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(signalPath, JSON.stringify({ action: 'resume' }), 'utf-8');
          return bot.send(chatId, '\u25B6\uFE0F Sending resume signal to Loop...');
        } catch (e) {
          return bot.send(chatId, `\u274C Error during resume: ${e.message}`);
        }
      }
      if (sub === 'pause') {
        loopManager.sendCommand('pause');
        return bot.send(chatId, '\u23F8 Pause signal sent to Loop.');
      }
      if (sub === 'kill' || sub === 'stop') {
        loopManager.shouldBeRunning = false;
        if (loopManager.childProc) {
          loopManager.childProc.kill('SIGTERM');
          loopManager.childProc = null;
        }
        return bot.send(chatId, '\u26D4 Loop killed.');
      }
      if (sub === 'status') {
        const running = loopManager.childProc ? '\u2705 Running' : '\u274C Stopped';
        const phase = loopManager.currentPhase || 'N/A';
        return bot.send(
          chatId,
          `*Loop Status*\n\n\u2022 State: ${running}\n\u2022 Phase: \`${phase}\`\n\u2022 Project: \`${st.project || 'bridge'}\``,
        );
      }
    }

    if (cmd === '/resume') {
      const currentProjectPath = loopManager.currentProjectPath || join(projectsRoot, 'loop');
      if (!loopManager.childProc) {
        await bot.send(chatId, '\u25B6\uFE0F Loop is not running. Starting it...');
        return loopManager.startLoop(chatId, st.project || null);
      }
      const signalPath = join(currentProjectPath, '.hydra', 'resume-signal.json');
      try {
        const dir = dirname(signalPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(signalPath, JSON.stringify({ action: 'resume' }), 'utf-8');
        return bot.send(chatId, '\u25B6\uFE0F Sending resume signal to Loop...');
      } catch (e) {
        return bot.send(chatId, `\u274C Error during resume: ${e.message}`);
      }
    }

    if (cmd === '/reset' || cmd === '/cleanup') {
      await bot.send(chatId, '\u{1F9F9} *Cleaning up...*');

      let deletedCount = 0;
      let filesCleaned = 0;

      try {
        /* Delete tracked bot messages from Telegram chat */
        await bot.deleteAllBotMessages(chatId);

        const loopDir = join(projectsRoot, 'loop');
        if (existsSync(loopDir)) {
          rmSync(loopDir, { recursive: true, force: true });
          deletedCount++;
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

        return bot.send(
          chatId,
          `\u2705 *Clean up completed!*\n\n- Projects removed: \`${deletedCount}\` (loop)\n- State files cleaned: \`${filesCleaned}\`\n- Chat messages cleaned\n- Session state reset.\n\nUse /new to start over.`,
        );
      } catch (e) {
        return bot.send(chatId, `\u274C *Error during clean up:* ${e.message}`);
      }
    }

    if (cmd === '/new') {
      wizard.startWizard(st);
      return bot.send(
        chatId,
        '\u{1F195} *New session*\n\n1\uFE0F\u20E3 Loop\n2\uFE0F\u20E3 Chat\n3\uFE0F\u20E3 Create project\n\nReply with 1, 2, or 3.',
      );
    }

    if (st.wizard) {
      return wizard.handleWizard(chatId, text, st);
    }

    if (cmd === '/start' || cmd === '/help') {
      return bot.send(
        chatId,
        [
          '*OPencode Modular Bridge*',
          '',
          'Commands:',
          '\u2022 `/new` \u2014 Start a new session (Loop / Chat / Create project)',
          '\u2022 `/loop start` \u2014 Start the Hydra Loop',
          '\u2022 `/loop resume` \u2014 Resume blocked loop',
          '\u2022 `/loop pause` \u2014 Pause the loop',
          '\u2022 `/loop status` \u2014 Check loop state',
          '\u2022 `/loop kill` \u2014 Stop the loop',
          '\u2022 `/reset` \u2014 Clean up state files and messages',
          '\u2022 `/help` \u2014 Show this message',
          '',
          'Or just type a message to chat with the active session.',
        ].join('\n'),
      );
    }

    if (st.sessionId) {
      bot.startTyping(chatId);
      try {
        const result = await opencodeClient.sendPrompt(
          st.sessionId,
          text,
          PROJECTS[st.project]?.path,
        );
        let replyText = result?.parts
          ?.map((p) => p.text || '')
          .join('\n')
          .trim();
        if (replyText) {
          await bot.send(chatId, `\u2705 *Response:*\n\n${replyText}`);
        } else {
          await bot.send(chatId, `\u2705 *Completed*`);
        }
      } catch (e) {
        await bot.send(chatId, `\u274C ${e.message}`);
      }
      bot.stopTyping(chatId);
    } else {
      bot.send(chatId, 'No active session. Use /new to start one, or /help for commands.');
    }
  };
}
