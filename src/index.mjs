#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

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

let restartCount = 0;
let lastRestartTime = 0;

const loopManager = {
  currentProjectPath: null,
  shouldBeRunning: false,
  startLoop: async (chatId, projectKey) => {
    try {
      const projName = projectKey || "loop";
      const projPath = projectKey
        ? (PROJECTS[projectKey]?.path || join(process.env.HOME || "/home/ubuntu", "projects", projectKey))
        : join(process.env.HOME || "/home/ubuntu", "projects", "loop");
        
      if (!existsSync(projPath)) {
        await bot.send(chatId, `❌ Errore: la directory del progetto non esiste: \`${projPath}\``);
        return;
      }

      loopManager.currentProjectPath = projPath;
      loopManager.shouldBeRunning = true;

      const loopScript = join(bridgePath, "agents/orchestrator/index.mjs");
      
      const child = spawn("node", [loopScript, projPath], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, HYDRA_CHAT_ID: String(chatId) }
      });
      
      orchestratorIpcManager.childProc = child;
      
      child.stdout.on("data", d => console.log("[loop]", d.toString().trim()));
      child.stderr.on("data", d => console.error("[loop]", d.toString().trim()));
      
      child.on("exit", async (code, signal) => {
        console.log(`[loop] Orchestrator exited with code ${code} and signal ${signal}`);
        orchestratorIpcManager.childProc = null;
        if (loopManager.shouldBeRunning) {
          const now = Date.now();
          if (now - lastRestartTime > 60000) {
            restartCount = 0; // Reset count after 1 minute of stable execution
          }
          if (restartCount < 5) {
            restartCount++;
            lastRestartTime = now;
            await bot.send(chatId, `⚠️ *Alert:* L'orchestratore Loop è terminato inaspettatamente (codice ${code}). Tentativo di riavvio ${restartCount}/5...`);
            setTimeout(() => {
              loopManager.startLoop(chatId, projectKey);
            }, 5000);
          } else {
            loopManager.shouldBeRunning = false;
            await bot.send(chatId, `🚨 *Errore Critico:* L'orchestratore Loop è terminato troppe volte consecutivamente. Riavvio automatico disabilitato.`);
          }
        } else {
          await bot.send(chatId, `ℹ️ L'orchestratore Loop è terminato normalmente.`);
        }
      });
      
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

  if (cmd === "/resume" || (cmd === "/loop" && args === "resume")) {
    const currentProjectPath = loopManager.currentProjectPath || join(process.env.HOME || "/home/ubuntu", "projects", "loop");
    if (!orchestratorIpcManager.childProc) {
      await bot.send(chatId, "▶️ L'orchestratore non è in esecuzione. Lo avvio...");
      loopManager.startLoop(chatId, st.project || null);
      return;
    }

    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const signalPath = join(currentProjectPath, ".hydra", "resume-signal.json");
    try {
      const dir = dirname(signalPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(signalPath, JSON.stringify({ action: "resume" }), "utf-8");
      return bot.send(chatId, "▶️ Invio segnale di ripresa al Loop...");
    } catch (e) {
      return bot.send(chatId, `❌ Errore durante la ripresa: ${e.message}`);
    }
  }

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

const offsetPath = join(bridgePath, ".hydra", "telegram-offset.json");
let offset = 0;
try {
  if (existsSync(offsetPath)) {
    offset = JSON.parse(readFileSync(offsetPath, "utf-8")).offset || 0;
  }
} catch (e) {
  console.error("Error loading Telegram offset:", e.message);
}

function saveOffset(newOffset) {
  offset = newOffset;
  try {
    const dir = dirname(offsetPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(offsetPath, JSON.stringify({ offset: newOffset }), "utf-8");
  } catch (e) {
    console.error("Error saving Telegram offset:", e.message);
  }
}

async function poll() {
  try {
      const data = await bot.callApi("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
      if (data.ok && data.result) {
          for (const upd of data.result) {
              saveOffset(upd.update_id + 1);
              if (upd.message) {
                  await handleMessage(upd.message).catch(e => console.error(e));
              } else if (upd.callback_query) {
                  const cb = upd.callback_query;
                  const data = cb.data;
                  const chatId = cb.message?.chat.id;
                  const userId = cb.from?.id;
                  
                  if (!userId || !ALLOWED_USERS.includes(userId)) {
                      await bot.send(chatId, "⛔ Non autorizzato.");
                      await bot.callApi("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
                      continue;
                  }

                  if (data === "hydra:resume" || data.startsWith("hydra:approve:") || data.startsWith("hydra:reject:")) {
                      const currentProjectPath = loopManager.currentProjectPath || join(process.env.HOME || "/home/ubuntu", "projects", "loop");
                      
                      if (!orchestratorIpcManager.childProc) {
                          await bot.send(chatId, "▶️ L'orchestratore non è in esecuzione. Lo avvio...");
                          loopManager.startLoop(chatId, null);
                      } else {
                          const signalPath = join(currentProjectPath, ".hydra", "resume-signal.json");
                          try {
                              const dir = dirname(signalPath);
                              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                              writeFileSync(signalPath, JSON.stringify({ action: "resume", data }), "utf-8");
                              await bot.send(chatId, "▶️ Invio segnale di ripresa al Loop...");
                          } catch (e) {
                              await bot.send(chatId, `❌ Errore durante la ripresa: ${e.message}`);
                          }
                      }
                  }
                  await bot.callApi("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
              }
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
processManager.startHealthServer(() => orchestratorIpcManager.childProc);

setTimeout(() => {
  if (processManager.healthOk) {
    console.log("Ready! Starting poll...");
    poll();
  } else {
    console.log("Waiting for opencode health...");
    setTimeout(() => poll(), 5000); // Wait a bit more
  }
}, 5000);
