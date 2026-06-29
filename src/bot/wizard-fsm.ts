import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import config from '../config/index.js';
import { PROJECTS } from '../core/projects.js';
import type { BridgeBot, ChatState } from './telegram-bot.js';
import type { LoopManager } from '../services/loop-manager.js';

const projectsRoot = join(config.system.rootDir, '..');

const WIZARD_ACTIONS: Record<string, string> = {
  '1': 'loop',
  loop: 'loop',
  '2': 'chat',
  chat: 'chat',
  '3': 'create',
  create: 'create',
};

export interface WizardState {
  step: string;
  action: string | null;
  newName: string | null;
  newPath: string | null;
  newDesc: string | null;
}

interface ChatSessionManager {
  createChatSession(chatId: number, projectKey: string, st: ChatState): Promise<void>;
}

export class WizardFSM {
  constructor(
    private readonly bot: BridgeBot,
    private readonly loopManager: LoopManager,
    private readonly chatSessionManager: ChatSessionManager,
  ) {}

  startWizard(st: ChatState, action: string | null = null): void {
    st.wizard = {
      step: 'action',
      action,
      newName: null,
      newPath: null,
      newDesc: null,
    } as unknown as Record<string, unknown>;
  }

  async handleWizard(chatId: number, text: string, st: ChatState): Promise<void> {
    const w = st.wizard as WizardState | null;
    if (!w) return;

    if (text.toLowerCase() === 'cancel' || text === '/cancel') {
      st.wizard = null;
      await this.bot.send(chatId, '❌ Wizard cancelled.');
      return;
    }

    if (text.toLowerCase() === 'back') {
      return this.wizardBack(chatId, st);
    }

    switch (w.step) {
      case 'action': {
        const action = WIZARD_ACTIONS[text.toLowerCase()];
        if (!action) {
          await this.bot.send(chatId, '❌ Reply with 1 (Loop), 2 (Chat) or 3 (Create project).');
          return;
        }
        w.action = action;
        if (action === 'loop') {
          st.wizard = null;
          await this.bot.send(chatId, '▶️ Starting Hydra Loop...');
          await this.loopManager.startLoop(chatId);
          return;
        }
        w.step = 'project';
        if (action === 'create') {
          await this.bot.send(
            chatId,
            'Give your project a name:\n\nUse letters, numbers, `-` or `_`.\n`back` to go back.',
          );
          return;
        }
        return this.wizardPickProject(chatId, st);
      }

      case 'project': {
        if (text.toLowerCase() === 'new') {
          w.step = 'new_name';
          await this.bot.send(chatId, '*Project name:* (e.g. `my-app`)\n\n`back` to go back.');
          return;
        }
        const choice = text.trim();
        const keys = Object.keys(PROJECTS);
        const idx = parseInt(choice, 10) - 1;
        const key = keys[idx] || choice;
        if (!PROJECTS[key]) {
          await this.bot.send(
            chatId,
            'Unknown project. Type the number or name.\n\nType `new` to create one.',
          );
          return;
        }
        st.project = key;
        st.wizard = null;
        await this.bot.send(
          chatId,
          `Starting chat session on \`${key}\` — ${PROJECTS[key].desc}...`,
        );
        return this.chatSessionManager.createChatSession(chatId, key, st);
      }

      case 'new_name': {
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(text.trim())) {
          await this.bot.send(
            chatId,
            'Invalid name. Use letters, numbers, `-` or `_` (max 40 chars).',
          );
          return;
        }
        w.newName = text.trim();
        w.step = 'new_path';
        await this.bot.send(
          chatId,
          `*Path:* (default: \`${join(projectsRoot, w.newName)}\`)\n\nLeave empty for default, \`back\` to go back.`,
        );
        return;
      }

      case 'new_path': {
        const p = text.trim();
        const chosenPath = p || join(projectsRoot, w.newName!);
        if (!resolve(chosenPath).startsWith(resolve(projectsRoot))) {
          await this.bot.send(
            chatId,
            'Path traversal detected. Use a path inside the projects directory.',
          );
          return;
        }
        w.newPath = chosenPath;
        w.step = 'new_desc';
        await this.bot.send(
          chatId,
          '*Description:* (optional, — or `skip`)\n\nE.g. "Next.js blog app"',
        );
        return;
      }

      case 'new_desc': {
        w.newDesc = ['skip', '—', '-'].includes(text.toLowerCase()) ? '' : text.trim();
        w.step = 'confirm';
        await this.bot.send(
          chatId,
          `*Confirm project creation*\n\n` +
            `Name: \`${w.newName}\`\n` +
            `Path: \`${w.newPath}\`\n` +
            `Description: ${w.newDesc || '—'}\n\n` +
            `Confirm? (yes / no, \`back\` to change)`,
        );
        return;
      }

      case 'confirm': {
        if (['yes', 'y', 'ok', 'confirm'].includes(text.toLowerCase())) {
          const key = w.newName!;
          PROJECTS[key] = { path: w.newPath!, desc: w.newDesc || key };
          st.project = key;
          try {
            await mkdir(w.newPath!, { recursive: true });
            await mkdir(join(w.newPath!, '.opencode'), { recursive: true });
            await writeFile(
              join(w.newPath!, '.opencode', 'opencode.json'),
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
          } catch {
            console.error('Project creation error');
          }
          await this.bot.send(chatId, `Project \`${key}\` created at \`${w.newPath}\``);
          if (w.action === 'create') {
            await this.bot.send(
              chatId,
              `What would you like to do on \`${key}\`?\n\n` +
                `1️⃣ Start Hydra Loop\n` +
                `2️⃣ Open chat session\n` +
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
            await this.loopManager.startLoop(chatId, key);
            return;
          }
          if (w.action === 'chat') {
            st.wizard = null;
            await this.chatSessionManager.createChatSession(chatId, key, st);
            return;
          }
          st.wizard = null;
          await this.bot.send(chatId, 'Done. Type /new to start again.');
          return;
        }
        this.startWizard(st, w.action);
        await this.bot.send(
          chatId,
          'Cancelled. Starting over.\n\n1️⃣ Loop\n2️⃣ Chat\n3️⃣ Create project',
        );
        return;
      }

      case 'post_create': {
        const act = WIZARD_ACTIONS[text.toLowerCase()];
        const key = w.newName!;
        if (!act || act === 'create' || !key || !PROJECTS[key]) {
          await this.bot.send(chatId, 'Choose 1 (Loop) or 2 (Chat).');
          return;
        }
        if (act === 'loop') {
          st.wizard = null;
          await this.loopManager.startLoop(chatId, key);
          return;
        }
        if (act === 'chat') {
          st.wizard = null;
          await this.chatSessionManager.createChatSession(chatId, key, st);
          return;
        }
        st.wizard = null;
        await this.bot.send(chatId, 'Done.');
        return;
      }

      default:
        st.wizard = null;
        await this.bot.send(chatId, 'Corrupted wizard. Use /new to start over.');
    }
  }

  private async wizardBack(chatId: number, st: ChatState): Promise<void> {
    const wizardState = st.wizard as WizardState | null;
    if (!wizardState) return;
    const w = wizardState;
    const prev: Record<string, string> = {
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
          await this.bot.send(chatId, '1️⃣ Loop\n2️⃣ Chat\n3️⃣ Create project');
          return;
        case 'new_name':
          await this.bot.send(chatId, '*Project name:*');
          return;
        case 'new_path':
          await this.bot.send(chatId, `*Path:* (default: \`${join(projectsRoot, w.newName!)}\`)`);
          return;
        case 'new_desc':
          await this.bot.send(chatId, '*Description:* (`skip` to skip)');
          return;
        case 'project':
          return this.wizardPickProject(chatId, st);
      }
    }
    this.startWizard(st);
    await this.bot.send(chatId, '1️⃣ Loop\n2️⃣ Chat\n3️⃣ Create project');
  }

  private async wizardPickProject(chatId: number, st: ChatState): Promise<void> {
    const keys = Object.keys(PROJECTS);
    const list = keys.map((k, i) => `  ${i + 1}. \`${k}\` — ${PROJECTS[k].desc}`).join('\n');
    await this.bot.send(
      chatId,
      `*Choose a project for chat:*\n\n${list}\n\nType the number or name.\n\`new\` to create one, \`back\` to go back.`,
    );
  }
}
