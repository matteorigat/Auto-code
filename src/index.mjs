#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

// Load .env
try {
  const envPath = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");
  console.log("Loading .env from:", envPath, "Exists:", existsSync(envPath));
  if (existsSync(envPath)) {
    for (const l of readFileSync(envPath, "utf-8").split("\n")) {
      const t = l.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      let key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      process.env[key] = val;
    }
  }
} catch (e) {
  console.error("Error loading .env:", e);
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN || TOKEN === "inserisci_il_token_qui") {
    console.error("ERRORE: imposta TELEGRAM_BOT_TOKEN in .env");
    process.exit(1);
}

function parseAllowedUsers() {
    const envUsers = process.env.TELEGRAM_ALLOWED_USER_ID;
    if (!envUsers) return [***REMOVED***];
    return envUsers.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

const ALLOWED_USERS = parseAllowedUsers();
const bridgePath = dirname(dirname(fileURLToPath(import.meta.url)));

import { ProcessManager } from "./services/process-manager.mjs";
import { TelegramBot } from "./bot/telegram-bot.mjs";
import { OpenCodeClient } from "./core/opencode-client.mjs";
import { WizardFSM } from "./bot/wizard-fsm.mjs";
import { PROJECTS } from "./core/projects.mjs";
import { DashboardServer } from "./dashboard/server.mjs";

const processManager = new ProcessManager(bridgePath);
const opencodeClient = new OpenCodeClient(processManager);

const orchestratorIpcManager = {
  childProc: null,
  sendCommand(cmd) {
    if (this.childProc && this.childProc.send) {
      this.childProc.send({ action: 'dashboard_cmd', cmd });
    }
  }
};

const dashboardServer = new DashboardServer(8081, orchestratorIpcManager);
dashboardServer.start();

const statePath = join(bridgePath, ".hydra", "chat-state.json");
const bot = new TelegramBot(TOKEN, statePath, ALLOWED_USERS);

import { spawn } from "node:child_process";

const loopManager = {
  startLoop: async (chatId, projectKey) => {
    try {
      const projName = projectKey || "loop";
      const projPath = projectKey
        ? (PROJECTS[projectKey]?.path || join(process.env.HOME || "/home/ubuntu", "projects", projectKey))
        : join(process.env.HOME || "/home/ubuntu", "projects", "loop");
        
      const loopScript = join(bridgePath, "agents/orchestrator/index.mjs");
      
      const child = spawn("node", [loopScript, projPath], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, HYDRA_CHAT_ID: String(chatId) }
      });
      
      orchestratorIpcManager.childProc = child;
      
      child.stdout.on("data", d => console.log("[loop]", d.toString().trim()));
      child.stderr.on("data", d => console.error("[loop]", d.toString().trim()));
      
      await bot.send(chatId, `✅ Hydra Loop avviato su \`${projName}\`.`);
    } catch (e) {
      await bot.send(chatId, `❌ Errore avvio loop: ${e.message}`);
    }
  }
};
const sessionManager = {
  createChatSession: async (chatId, projectKey, st) => {
    try {
      const session = await opencodeClient.createSession(PROJECTS[projectKey].path);
      st.sessionId = session.id;
      opencodeClient.subscribeEvents(PROJECTS[projectKey].path, () => bot.stopAllTyping());
      await bot.send(chatId, `✅ Sessione \`${session.id.substring(0, 8)}…\` aperta su \`${projectKey}\`.\\nOra puoi scrivere direttamente un task.`);
    } catch (e) {
      await bot.send(chatId, `❌ ${e.message}`);
    }
  }
};

const wizard = new WizardFSM(bot, loopManager, sessionManager);

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text?.trim();
  if (!text || !userId) return;

  if (!ALLOWED_USERS.includes(userId)) {
      return bot.send(chatId, "⛔ Non autorizzato.");
  }

  const st = bot.getState(chatId);
  if (msg.message_id) bot.persistMsgId(chatId, msg.message_id, "user");

  const [cmd, ...rest] = text.split(/\\s+/);
  const args = rest.join(" ");

  if (cmd === "/new") {
    wizard.startWizard(st);
    return bot.send(chatId, "🆕 *Nuovo avvio*\\n\\n1️⃣ Loop\\n2️⃣ Chat\\n3️⃣ Crea progetto");
  }

  if (st.wizard) {
    return wizard.handleWizard(chatId, text, st);
  }

  if (cmd === "/start" || cmd === "/help") {
      return bot.send(chatId, "🤖 *OPencode Modular Bridge*\\nMigrated to src/ architecture.\\n/new per iniziare.");
  }

  // Execute task if there is an active session
  if (st.sessionId) {
    bot.startTyping(chatId);
    try {
        const result = await opencodeClient.sendPrompt(st.sessionId, text, PROJECTS[st.project]?.path);
        let replyText = result?.parts?.map(p => p.text || "").join("\\n").trim();
        if (replyText) {
            await bot.send(chatId, `✅ *Risposta:*\\n\\n\`\`\`\\n${replyText.substring(0, 3500)}\\n\`\`\``);
        } else {
            await bot.send(chatId, `✅ *Completato*`);
        }
    } catch (e) {
        await bot.send(chatId, `❌ ${e.message}`);
    }
    bot.stopTyping(chatId);
  } else {
    bot.send(chatId, "Nessuna sessione attiva. Usa /new");
  }
}

let offset = 0;
async function poll() {
  try {
      const data = await bot.callApi("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      if (data.ok && data.result) {
          for (const upd of data.result) {
              offset = upd.update_id + 1;
              if (upd.message) await handleMessage(upd.message).catch(e => console.error(e));
          }
      }
  } catch (err) {
      console.error("poll error:", err.message);
  }
  setTimeout(poll, 300);
}

console.log("Starting modular bridge...");
processManager.startLiteLLM();
processManager.startOpencode();
processManager.startHealthServer();

setTimeout(() => {
  if (processManager.healthOk) {
    console.log("Ready! Starting poll...");
    poll();
  } else {
    console.log("Waiting for opencode health...");
    setTimeout(() => poll(), 5000); // Wait a bit more
  }
}, 5000);
