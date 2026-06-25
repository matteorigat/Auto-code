import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import config from '../config/index.mjs';
import { PROJECTS } from '../core/projects.mjs';

const projectsRoot = join(config.system.rootDir, '..');

const WIZARD_ACTIONS = {
  1: 'loop',
  loop: 'loop',
  2: 'chat',
  chat: 'chat',
  3: 'create',
  create: 'create',
};

export class WizardFSM {
  constructor(bot, loopManager, chatSessionManager) {
    this.bot = bot;
    this.loopManager = loopManager;
    this.chatSessionManager = chatSessionManager;
  }

  startWizard(st, action = null) {
    st.wizard = { step: 'action', action, newName: null, newPath: null, newDesc: null };
  }

  async handleWizard(chatId, text, st) {
    const w = st.wizard;
    if (!w) return;

    if (text.toLowerCase() === 'cancel' || text === '/cancel') {
      st.wizard = null;
      return this.bot.send(chatId, '\u274C Wizard cancelled.');
    }

    if (text.toLowerCase() === 'back') {
      return this._wizardBack(chatId, st);
    }

    switch (w.step) {
      case 'action': {
        const action = WIZARD_ACTIONS[text.toLowerCase()];
        if (!action) {
          return this.bot.send(
            chatId,
            '\u274C Reply with 1 (Loop), 2 (Chat) or 3 (Create project).',
          );
        }
        w.action = action;
        if (action === 'loop') {
          st.wizard = null;
          await this.bot.send(chatId, '\u25B6\uFE0F Starting Hydra Loop...');
          return this.loopManager.startLoop(chatId);
        }
        w.step = 'project';
        if (action === 'create') {
          return this.bot.send(
            chatId,
            'Give your project a name:\n\nUse letters, numbers, `-` or `_`.\n`back` to go back.',
          );
        }
        return this._wizardPickProject(chatId, st);
      }

      case 'project': {
        if (text.toLowerCase() === 'new') {
          w.step = 'new_name';
          return this.bot.send(chatId, '*Project name:* (e.g. `my-app`)\n\n`back` to go back.');
        }
        const choice = text.trim();
        const keys = Object.keys(PROJECTS);
        const idx = parseInt(choice, 10) - 1;
        const key = keys[idx] || choice;
        if (!PROJECTS[key]) {
          return this.bot.send(
            chatId,
            'Unknown project. Type the number or name.\n\nType `new` to create one.',
          );
        }
        st.project = key;
        st.wizard = null;
        await this.bot.send(
          chatId,
          `Starting chat session on \`${key}\` \u2014 ${PROJECTS[key].desc}...`,
        );
        return this.chatSessionManager.createChatSession(chatId, key, st);
      }

      case 'new_name': {
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(text.trim())) {
          return this.bot.send(
            chatId,
            'Invalid name. Use letters, numbers, `-` or `_` (max 40 chars).',
          );
        }
        w.newName = text.trim();
        w.step = 'new_path';
        return this.bot.send(
          chatId,
          `*Path:* (default: \`${join(projectsRoot, w.newName)}\`)\n\nLeave empty for default, \`back\` to go back.`,
        );
      }

      case 'new_path': {
        const p = text.trim();
        let chosenPath = p || join(projectsRoot, w.newName);
        if (!resolve(chosenPath).startsWith(resolve(projectsRoot))) {
          return this.bot.send(
            chatId,
            'Path traversal detected. Use a path inside the projects directory.',
          );
        }
        w.newPath = chosenPath;
        w.step = 'new_desc';
        return this.bot.send(
          chatId,
          '*Description:* (optional, \u2014 or \`skip\`)\n\nE.g. "Next.js blog app"',
        );
      }

      case 'new_desc': {
        w.newDesc = ['skip', '\u2014', '-'].includes(text.toLowerCase()) ? '' : text.trim();
        w.step = 'confirm';
        return this.bot.send(
          chatId,
          `*Confirm project creation*\n\n` +
            `Name: \`${w.newName}\`\n` +
            `Path: \`${w.newPath}\`\n` +
            `Description: ${w.newDesc || '\u2014'}\n\n` +
            `Confirm? (yes / no, \`back\` to change)`,
        );
      }

      case 'confirm': {
        if (['yes', 'y', 'ok', 'confirm'].includes(text.toLowerCase())) {
          const key = w.newName;
          PROJECTS[key] = { path: w.newPath, desc: w.newDesc || key };
          st.project = key;
          try {
            await mkdir(w.newPath, { recursive: true });
            await mkdir(join(w.newPath, '.opencode'), { recursive: true });
            await writeFile(
              join(w.newPath, '.opencode', 'opencode.json'),
              JSON.stringify(
                {
                  $schema: 'https://opencode.ai/config.json',
                  permission: 'allow',
                  model: 'openai/tier-4-planner',
                  compaction: { auto: true, prune: true, reserved: 30000 },
                  provider: {
                    openai: {
                      options: {
                        baseURL: 'http://127.0.0.1:4000/v1',
                      },
                    },
                  },
                },
                null,
                2,
              ),
            );
          } catch (e) {
            console.error('Project creation error:', e.message);
          }
          await this.bot.send(chatId, `Project \`${key}\` created at \`${w.newPath}\``);
          if (w.action === 'create') {
            await this.bot.send(
              chatId,
              `What would you like to do on \`${key}\`?\n\n` +
                `1\uFE0F\u20E3 Start Hydra Loop\n` +
                `2\uFE0F\u20E3 Open chat session\n` +
                `\`cancel\` to finish.`,
            );
            w.action = null;
            w.step = 'post_create';
            w.newName = key;
            return;
          }
          if (w.action === 'loop') {
            st.wizard = null;
            await this.bot.send(chatId, `Starting Hydra Loop on \`${key}\`...`);
            return this.loopManager.startLoop(chatId, key);
          }
          if (w.action === 'chat') {
            st.wizard = null;
            return this.chatSessionManager.createChatSession(chatId, key, st);
          }
          st.wizard = null;
          return this.bot.send(chatId, 'Done. Type /new to start again.');
        }
        this.startWizard(st, w.action);
        return this.bot.send(
          chatId,
          'Cancelled. Starting over.\n\n1\uFE0F\u20E3 Loop\n2\uFE0F\u20E3 Chat\n3\uFE0F\u20E3 Create project',
        );
      }

      case 'post_create': {
        const act = WIZARD_ACTIONS[text.toLowerCase()];
        const key = w.newName;
        if (!act || act === 'create' || !key || !PROJECTS[key]) {
          return this.bot.send(chatId, 'Choose 1 (Loop) or 2 (Chat).');
        }
        if (act === 'loop') {
          st.wizard = null;
          return this.loopManager.startLoop(chatId, key);
        }
        if (act === 'chat') {
          st.wizard = null;
          return this.chatSessionManager.createChatSession(chatId, key, st);
        }
        st.wizard = null;
        return this.bot.send(chatId, 'Done.');
      }

      default:
        st.wizard = null;
        return this.bot.send(chatId, 'Corrupted wizard. Use /new to start over.');
    }
  }

  async _wizardBack(chatId, st) {
    const w = st.wizard;
    const prev = {
      new_name: 'action',
      new_path: 'new_name',
      new_desc: 'new_path',
      confirm: 'new_desc',
      project: 'action',
      post_create: 'action',
    };
    const p = prev[w.step];
    if (p) {
      w.step = p;
      switch (p) {
        case 'action':
          return this.bot.send(
            chatId,
            '1\uFE0F\u20E3 Loop\n2\uFE0F\u20E3 Chat\n3\uFE0F\u20E3 Create project',
          );
        case 'new_name':
          return this.bot.send(chatId, '*Project name:*');
        case 'new_path':
          return this.bot.send(chatId, `*Path:* (default: \`${join(projectsRoot, w.newName)}\`)`);
        case 'new_desc':
          return this.bot.send(chatId, '*Description:* (\`skip\` to skip)');
        case 'project':
          return this._wizardPickProject(chatId, st);
      }
    }
    this.startWizard(st);
    return this.bot.send(
      chatId,
      '1\uFE0F\u20E3 Loop\n2\uFE0F\u20E3 Chat\n3\uFE0F\u20E3 Create project',
    );
  }

  async _wizardPickProject(chatId, st) {
    const keys = Object.keys(PROJECTS);
    const list = keys.map((k, i) => `  ${i + 1}. \`${k}\` \u2014 ${PROJECTS[k].desc}`).join('\n');
    await this.bot.send(
      chatId,
      `*Choose a project for chat:*\n\n${list}\n\nType the number or name.\n\`new\` to create one, \`back\` to go back.`,
    );
  }
}
