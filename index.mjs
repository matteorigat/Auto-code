#!/usr/bin/env node
/**
 * OpenCode Telegram Bridge v3 — API server mode con streaming live
 *
 * Differenze dalla v2:
 *  - Gestisce `opencode serve --port 4096` come subprocess
 *  - Usa l'API REST di opencode invece di `opencode run`
 *  - Streaming live via SSE: mostra "💭 Thinking...", tool calls in tempo reale
 *  - Session management: /new, /sessions, /abort
 *  - Pin status message con progetto e modello correnti
 *  - Output inviato come file se troppo lungo
 *
 * Uso:
 *   export TELEGRAM_BOT_TOKEN="..."
 *   node opencode-bridge-v3.mjs
 */

import { EventEmitter } from "node:events";
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

let loopProc = null;

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════

// Load .env file first (handles quoted values like KEY="value with spaces")
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), ".env");
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
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN || TOKEN === "inserisci_il_token_qui") {
    console.error("ERRORE: imposta TELEGRAM_BOT_TOKEN in .env");
    process.exit(1);
}

const OC_PORT = 4096;
const OC_URL = `http://127.0.0.1:${OC_PORT}`;

function parseAllowedUsers() {
    const envUsers = process.env.TELEGRAM_ALLOWED_USER_ID;
    if (!envUsers) return [***REMOVED***];
    return envUsers.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

const ALLOWED_USERS = parseAllowedUsers();

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "9090", 10);
const _startupTime = Date.now();

let opencodeRestartDelay = 3000;

function startHealthServer() {
  const server = createServer((req, res) => {
    if (req.url === "/api/health" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        opencodeServer: healthOk,
        opencodeRestartDelay,
        loopRunning: !!loopProc,
        uptime: Math.floor((Date.now() - _startupTime) / 1000),
      }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(HEALTH_PORT, "127.0.0.1", () => {
    console.log(`💚 Health server on http://127.0.0.1:${HEALTH_PORT}/health`);
  });
  server.on("error", (err) => console.error("Health server error:", err.message));
}

import { PROJECTS } from "./lib/projects.mjs";
import { MemoryManager } from "./lib/memory-manager.mjs";

const TG_API = `https://api.telegram.org/bot${TOKEN}`;

// ═══════════════════════════════════════════════════════════════════
// STATO
// ═══════════════════════════════════════════════════════════════════

const chatState = {}; // chatId -> { project, model, sessionId, pinnedMsgId, wizard, msgIds }
let opencodeProc = null;
let healthOk = false;

const CHAT_STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), ".hydra", "chat-state.json");

function _loadChatState() {
    try { return JSON.parse(readFileSync(CHAT_STATE_PATH, "utf-8")); } catch { return {}; }
}

function _saveChatState() {
    try { writeFileSync(CHAT_STATE_PATH, JSON.stringify(chatState)); } catch {}
}

// Debounced auto-save: schedules a save after mutations settle
let _saveTimer = null;
function _scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => { _saveTimer = null; _saveChatState(); }, 500);
}

function getState(cid) {
    if (!chatState[cid]) {
        const saved = _loadChatState();
chatState[cid] = saved[cid] || {
             project: "bridge",
             model: null,
             sessionId: null,
             pinnedMsgId: null,
             wizard: null,
             msgIds: [],
         };
    }
    // Return a proxy that auto-saves on any mutation
    if (!chatState[cid]._proxy) {
        const raw = chatState[cid];
        chatState[cid] = new Proxy(raw, {
            set(target, prop, value) {
                target[prop] = value;
                _scheduleSave();
                return true;
            },
            deleteProperty(target, prop) {
                delete target[prop];
                _scheduleSave();
                return true;
            },
        });
    }
    return chatState[cid];
}

function _persistMsgId(chatId, messageId, type = "bot") {
    const st = getState(chatId);
    st.msgIds = [...(st.msgIds || []), { id: messageId, type }];
    _scheduleSave();
}

// Wizard initializer
function startWizard(st, action = null) {
    st.wizard = { step: "action", action, newName: null, newPath: null, newDesc: null };
}

// ═══════════════════════════════════════════════════════════════════
// GESTIONE OPENCODE SERVE
// ═══════════════════════════════════════════════════════════════════

function startOpencode() {
    if (opencodeProc) return;
    console.log(`🚀 Avvio opencode serve... (backoff: ${opencodeRestartDelay}ms)`);
    const bridgePath = dirname(fileURLToPath(import.meta.url));
    const home = homedir();
    opencodeProc = spawn("opencode", ["serve", "--port", String(OC_PORT)], {
        cwd: bridgePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            PATH: `${process.env.PATH || ""}:${join(home, ".opencode", "bin")}:${join(home, ".npm-global", "bin")}`,
        },
    });
    opencodeProc.stdout.on("data", (d) =>
        process.stdout.write(`[opencode] ${d}`),
    );
    opencodeProc.stderr.on("data", (d) =>
        process.stderr.write(`[opencode-err] ${d}`),
    );
    opencodeProc.on("exit", async (code) => {
        console.log(
            `⚠️ opencode terminato (codice ${code}), riavvio tra ${opencodeRestartDelay}ms...`,
        );
        opencodeProc = null;
        healthOk = false;
        await new Promise((r) => setTimeout(r, opencodeRestartDelay));
        opencodeRestartDelay = Math.min(opencodeRestartDelay * 2, 60000); // max 60s
        startOpencode();
        const ok = await waitForHealth(10);
        if (ok) opencodeRestartDelay = 3000; // reset on success
    });
}

async function waitForHealth(retries = 15) {
    for (let i = 0; i < retries; i++) {
        try {
            const r = await fetch(`${OC_URL}/api/health`);
            if (r.ok) {
                healthOk = true;
                console.log("✅ opencode server pronto");
                return true;
            }
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.error(
        "❌ opencode server non disponibile dopo",
        retries,
        "tentativi",
    );
    return false;
}

async function api(path, opts = {}) {
    if (!healthOk && !path.startsWith("/api/health"))
        throw new Error("opencode server non disponibile");
    const url = `${OC_URL}${path}`;
    const res = await fetch(url, {
        ...opts,
        headers: {
            "Content-Type": "application/json",
            "x-opencode-directory": opts.directory || "",
            ...opts.headers,
        },
        body: opts.body,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API ${path}: ${res.status} ${text.substring(0, 200)}`);
    }
    if (opts.raw || opts.rawResponse) return res;
    return res.json();
}

// ═══════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

async function createSession(directory) {
    return api("/session", {
        method: "POST",
        body: JSON.stringify({}),
        directory,
    });
}

async function listSessions(directory) {
    return api("/session?limit=20", { directory });
}

async function sendPrompt(sessionId, text, directory) {
    return api(`/session/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
        directory,
    });
}

async function abortSession(sessionId, directory) {
    return api(`/session/${sessionId}/abort`, { method: "POST", directory });
}

async function getSessionStatus(directory) {
    return api("/session/status", { directory });
}

// ═══════════════════════════════════════════════════════════════════
// SSE EVENT STREAM
// ═══════════════════════════════════════════════════════════════════

let sseController = null;
const eventBus = new EventEmitter();

async function subscribeEvents(directory) {
    if (sseController) {
        sseController.abort();
    }
    sseController = new AbortController();

    try {
        const res = await fetch(`${OC_URL}/global/event`, {
            headers: {
                "x-opencode-directory": directory || "",
                Accept: "text/event-stream",
            },
            signal: sseController.signal,
        });
        if (!res.ok) {
            console.error("SSE connection failed:", res.status);
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        eventBus.emit("event", data);
                    } catch (_) {}
                }
            }
        }
    } catch (err) {
        if (err.name !== "AbortError") console.error("SSE error:", err.message);
    }
    sseController = null;
}

// Process SSE events: stop typing on session completion
eventBus.on("event", (data) => {
    if (data.type === "message.updated" && data.properties?.info?.time?.completed) {
        for (const cid of Object.keys(typingTimers)) {
            stopTyping(Number(cid));
        }
    }
});

// ═══════════════════════════════════════════════════════════════════
// API TELEGRAM
// ═══════════════════════════════════════════════════════════════════

const _idempotencyCache = new Map();

function _idempotencyKey(method, payload) {
  return method + ":" + JSON.stringify(payload);
}

async function tg(method, payload = {}) {
    const key = _idempotencyKey(method, payload);
    const cached = _idempotencyCache.get(key);
    if (cached && Date.now() - cached.ts < 5000) return cached.result;
    const res = await fetch(`${TG_API}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const result = await res.json();
    _idempotencyCache.set(key, { ts: Date.now(), result });
    if (_idempotencyCache.size > 500) {
      const keys = [..._idempotencyCache.keys()].slice(0, 100);
      for (const k of keys) _idempotencyCache.delete(k);
    }
    return result;
}

function inlineKeyboard(rows) {
    return JSON.stringify({ inline_keyboard: rows });
}

async function send(chatId, text, opt = {}) {
    if (!text) text = "✅";
    const MAX = 4000;
    const chunks = [];
    let t = text;
    while (t.length > MAX) {
        let cut = t.lastIndexOf("\n", MAX);
        if (cut < MAX / 2) cut = MAX;
        chunks.push(t.slice(0, cut));
        t = t.slice(cut).trim();
    }
    if (t) chunks.push(t);
    const st = chatState[chatId];
    for (let i = 0; i < chunks.length; i++) {
        const res = await tg("sendMessage", {
            chat_id: chatId,
            text: chunks[i],
            parse_mode: opt.md !== false ? "Markdown" : undefined,
            disable_web_page_preview: true,
        });
        if (res.ok && res.result?.message_id && st) {
            _persistMsgId(chatId, res.result.message_id);
        }
    }
}

async function sendAction(chatId) {
    try {
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════
// COMANDI
// ═══════════════════════════════════════════════════════════════════

function codeBlock(text, lang = "") {
    return "```" + lang + "\n" + (text || "").replace(/```/g, "'''") + "\n```";
}

/* ─── Wizard: assistente `/new` ─── */

const WIZARD_ACTIONS = {
    "1": "loop", "loop": "loop",
    "2": "chat", "chat": "chat",
    "3": "create", "create": "create",
};

async function handleWizard(chatId, text, st) {
    const w = st.wizard;
    if (!w) return;

    // Cancel any time
    if (text.toLowerCase() === "cancel" || text === "/cancel" || text === "❌") {
        st.wizard = null;
        return send(chatId, "❌ Wizard annullato.");
    }

    // Back any time
    if (text.toLowerCase() === "back" || text === "🔙") {
        return _wizardBack(chatId, st);
    }

    switch (w.step) {
        /* ── Step 1: choose action ── */
        case "action": {
            const action = WIZARD_ACTIONS[text.toLowerCase()];
            if (!action) {
                return send(chatId, "❌ Non ho capito. Rispondi con 1 (loop), 2 (chat) o 3 (create).");
            }
            w.action = action;
            if (action === "loop") {
                // Loop è globale — avvia subito, nessun progetto
                st.wizard = null;
                await send(chatId, "🔄 Avvio Hydra Loop globale (basato su Notion)...");
                return _startLoop(chatId);
            }
            w.step = "project"; // chat e create passano per la scelta progetto
            if (action === "create") {
                return send(chatId, "📝 *Nome progetto:* (es. `my-app`)\n\nPoi potrai avviare loop o chat su di esso.\n\`back\` per tornare.");
            }
            return _wizardPickProject(chatId, st);
        }

        /* ── Step 2: pick existing project (solo per chat) ── */
        case "project": {
            if (text.toLowerCase() === "new") {
                w.step = "new_name";
                return send(chatId, "📝 *Nome progetto:* (es. `my-app`)\n\nScrivi \`back\` per tornare indietro.");
            }
            const choice = text.trim();
            const keys = Object.keys(PROJECTS);
            const idx = parseInt(choice, 10) - 1;
            const key = keys[idx] || choice;
            if (!PROJECTS[key]) {
                return send(chatId, `❌ Progetto sconosciuto. Scrivi il numero o il nome.\n\nScrivi \`new\` per crearne uno nuovo.`);
            }
            st.project = key;
            st.wizard = null;
            await send(chatId, `💬 Apro sessione chat su \`${key}\` — ${PROJECTS[key].desc}...`);
            return _createChatSession(chatId, key, st);
        }

        /* ── Step 2b: new project name ── */
        case "new_name": {
            if (!/^[a-zA-Z0-9_-]{1,40}$/.test(text.trim())) {
                return send(chatId, "❌ Nome non valido. Usa lettere, numeri, `-` o `_` (max 40 caratteri).");
            }
            w.newName = text.trim();
            w.step = "new_path";
            const home = homedir();
            return send(chatId, `📁 *Percorso:* (es. \`${join(home, "projects", w.newName)}\`)\n\nLascia vuoto per usare il default, \`back\` per tornare.`);
        }

        case "new_path": {
            const p = text.trim();
            w.newPath = p || join(homedir(), "projects", w.newName);
            w.step = "new_desc";
            return send(chatId, "📄 *Descrizione:* (opzionale, scrivi \`skip\` per saltare)\n\nEs. \"Next.js blog app\"");
        }

        case "new_desc": {
            w.newDesc = text.toLowerCase() === "skip" ? "" : text.trim();
            w.step = "confirm";
            return send(chatId,
                `📋 *Conferma creazione progetto*\n\n` +
                `Nome: \`${w.newName}\`\n` +
                `Percorso: \`${w.newPath}\`\n` +
                `Descrizione: ${w.newDesc || "—"}\n\n` +
                `Confermi? (si / no, \`back\` per modificare)`
            );
        }

        case "confirm": {
            if (["si", "sì", "yes", "y", "ok", "confermo"].includes(text.toLowerCase())) {
                const key = w.newName;
                PROJECTS[key] = { path: w.newPath, desc: w.newDesc || key };
                st.project = key;
                try {
                    await mkdir(w.newPath, { recursive: true });
                    await mkdir(join(w.newPath, ".opencode"), { recursive: true });
                    await writeFile(join(w.newPath, ".opencode", "opencode.json"), JSON.stringify({
                        "$schema": "https://opencode.ai/config.json",
                        "permission": "allow",
                        "model": "openai/tier-4-planner",
                        "compaction": { "auto": true, "prune": true, "reserved": 30000 },
                        "provider": {
                            "openai": {
                                "options": {
                                    "baseURL": "http://127.0.0.1:4000/v1"
                                }
                            }
                        }
                    }, null, 2));
                } catch {}
                await send(chatId, `✅ Progetto \`${key}\` creato in \`${w.newPath}\``);
                if (w.action === "create") {
                    // Dopo creazione chiedi se avviare loop o chat
                    await send(chatId,
                        `Cosa vuoi fare su \`${key}\`?\n\n` +
                        `1️⃣ Avviare Hydra Loop\n` +
                        `2️⃣ Aprire sessione chat\n` +
                        `\`cancel\` per terminare.`
                    );
                    w.action = null; // reset action, user picks again
                    w.step = "post_create";
                    w.newName = key; // remember project for post_create
                    return;
                }
                if (w.action === "loop") {
                    st.wizard = null;
                    await send(chatId, `🔄 Avvio Hydra Loop su \`${key}\`...`);
                    return _startLoop(chatId, key);
                }
                if (w.action === "chat") {
                    st.wizard = null;
                    return _createChatSession(chatId, key, st);
                }
                st.wizard = null;
                return send(chatId, "✅ Fatto. Scrivi /new per iniziare.");
            }
            // No → restart
            startWizard(st, w.action);
            return send(chatId, "❌ Annullato. Ricominciamo.\n\n1️⃣ Loop\n2️⃣ Chat\n3️⃣ Crea progetto");
        }

        /* ── Post-create: loop o chat sul progetto appena creato ── */
        case "post_create": {
            const act = WIZARD_ACTIONS[text.toLowerCase()];
            const key = w.newName;
            if (!act || act === "create" || !key || !PROJECTS[key]) {
                return send(chatId, "❌ Scegli 1 (loop) o 2 (chat).");
            }
            if (act === "loop") {
                st.wizard = null;
                return _startLoop(chatId, key);
            }
            if (act === "chat") {
                st.wizard = null;
                return _createChatSession(chatId, key, st);
            }
            st.wizard = null;
            return send(chatId, "✅ Fatto.");
        }

        default:
            st.wizard = null;
            return send(chatId, "❌ Wizard corrotto. Usa /new per ricominciare.");
    }
}

async function _wizardBack(chatId, st) {
    const w = st.wizard;
    const prev = { new_name: "action", new_path: "new_name", new_desc: "new_path", confirm: "new_desc", project: "action", post_create: "action" };
    const p = prev[w.step];
    if (p) {
        w.step = p;
        if (p === "action") return send(chatId, "1️⃣ Loop\n2️⃣ Chat\n3️⃣ Crea progetto");
        if (p === "new_name") return send(chatId, "📝 *Nome progetto:*");
        if (p === "new_path") {
            const home = homedir();
            return send(chatId, `📁 *Percorso:* (default: \`${join(home, "projects", w.newName)}\`)`);
        }
        if (p === "new_desc") return send(chatId, "📄 *Descrizione:* (\`skip\` per saltare)");
        if (p === "project") return _wizardPickProject(chatId, st);
    }
    startWizard(st);
    return send(chatId, "1️⃣ Loop\n2️⃣ Chat\n3️⃣ Crea progetto");
}

async function _wizardPickProject(chatId, st) {
    const keys = Object.keys(PROJECTS);
    const list = keys.map((k, i) => `  ${i + 1}. \`${k}\` — ${PROJECTS[k].desc}`).join("\n");
    await send(chatId,
        `📁 *Scegli progetto per la chat:*\n\n${list}\n\nScrivi il numero o il nome.\n\`new\` per crearne uno, \`back\` per tornare.`
    );
}

/* ─── Helpers eseguiti dal wizard ─── */

async function _startLoop(chatId, projectKey) {
    const loopScript = join(dirname(fileURLToPath(import.meta.url)), "agents", "hydra-loop.mjs");
    if (loopProc) { try { loopProc.kill("SIGTERM"); } catch {} loopProc = null; }

    // Use project path if provided, else global ~/projects/loop/
    const projName = projectKey || "loop";
    const projPath = projectKey
        ? (PROJECTS[projectKey]?.path || join(homedir(), "projects", projectKey))
        : join(homedir(), "projects", "loop");

    // Ensure global dir exists
    if (!projectKey) {
        await mkdir(projPath, { recursive: true }).catch(() => {});
    }

    // Persist chatId + project path so hydra-loop and status can find them
    const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), ".hydra");
    await mkdir(bridgeDir, { recursive: true }).catch(() => {});
    await writeFile(join(bridgeDir, "bridge-chat.json"), JSON.stringify({ chatId }, null, 2)).catch(() => {});
    await writeFile(join(bridgeDir, "loop-project.json"), JSON.stringify({ projectPath: projPath, projectName: projName }, null, 2)).catch(() => {});
    try {
        const home = homedir();
        loopProc = spawn("node", [loopScript, projPath, "--chat-id", String(chatId), "--tag", projName], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PATH: `${process.env.PATH || ""}:${join(home, ".opencode", "bin")}:${join(home, ".npm-global", "bin")}` },
        });
        loopProc.stdout.on("data", d => console.log("[loop]", d.toString().trim()));
        loopProc.stderr.on("data", d => console.error("[loop]", d.toString().trim()));
        loopProc.on("exit", (code) => { console.log(`[loop] uscito ${code}`); loopProc = null; stopHeartbeatWatch(); });
        startHeartbeatWatch();
        const tag = projectKey ? `su \`${projectKey}\`` : "globale";
        await send(chatId, `✅ Hydra Loop avviato ${tag}.\n🤖 'sta scrivendo…' — sistema vivo.`);
    } catch (e) { await send(chatId, "❌ Loop: " + e.message); }
}

async function _loopStatus(chatId) {
    const lines = ["🤖 *Hydra Loop — Stato Completo*"];

    const alive = loopProc ? "✅ Attivo" : "⏸️ Fermo";
    const pid = loopProc?.pid ? ` (PID ${loopProc.pid})` : "";
    lines.push(`• Processo: ${alive}${pid}`);

    // Determine project path from saved state
    const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), ".hydra");
    let projectPath = null;
    try {
        const lp = JSON.parse(readFileSync(join(bridgeDir, "loop-project.json"), "utf-8"));
        projectPath = lp.projectPath;
        if (lp.projectName) lines.push(`• Progetto: \`${lp.projectName}\``);
    } catch {}
    if (!projectPath) projectPath = join(homedir(), "projects", "loop");

    const checkpointPath = join(projectPath, ".hydra", "loop-checkpoint.json");
    try {
        const cp = JSON.parse(readFileSync(checkpointPath, "utf-8"));
        lines.push(`• Fase: \`${cp.phase}\``);
        if (cp.currentStory) lines.push(`• Task: *${cp.currentStory}*`);
        if (cp.currentTaskId) lines.push(`• Task ID: \`${cp.currentTaskId}\``);
        lines.push(`• Tentativo: ${cp.attempt || 1}/${cp.maxAttempts || 3}`);
        if (cp.costAccumulatorUsd > 0) lines.push(`• Costo: $${cp.costAccumulatorUsd.toFixed(2)}`);
        lines.push(`• Aggiornato: ${cp.updatedAt || "—"}`);
    } catch {
        lines.push("• Checkpoint: non trovato");
    }

    const metaPath = join(projectPath, ".task-current.json");
    try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        if (meta.description) lines.push(`• Descrizione: ${meta.description.slice(0, 120)}`);
        if (meta.tag) lines.push(`• Tag: ${meta.tag}`);
        if (meta.notionUrl) lines.push(`• Notion: [Vai](${meta.notionUrl})`);
    } catch {}

    try {
        const { NotionAdapter } = await import("./lib/notion-adapter.mjs");
        const notion = new NotionAdapter();
        if (notion.isReady()) {
            const tasks = await notion.pullTasks();
            const total = tasks.length;
            const excl = tasks.filter(t => t.excluded).length;
            lines.push(`• Notion: ${total} idee (${excl} escluse dal loop)`);
        }
    } catch {}

    try {
        const gitLog = execSync("git log --oneline -3 2>/dev/null", { cwd: projectPath, shell: "/bin/bash", timeout: 5000 }).toString().trim();
        if (gitLog) {
            lines.push("• Git:");
            for (const l of gitLog.split("\n")) lines.push(`  \`${l}\``);
        }
    } catch {}

    await send(chatId, lines.join("\n"));
}

async function _logCommand(chatId, args, st) {
    const n = parseInt(args, 10) || 15;
    const projPath = st?.project ? PROJECTS[st.project]?.path : null;
    if (!projPath) return send(chatId, "❌ Nessun progetto selezionato. Usa /project <nome>");
    const memory = new MemoryManager(projPath);
    const events = memory.readRecentEvents(Math.min(n, 50));
    if (!events.length) return send(chatId, "📝 Nessun evento recente.");
    const lines = events.map((e) => {
        const time = new Date(e.ts).toISOString().slice(11, 19);
        const p = e.payload || {};
        return `\`${time}\` [${e.type}] ${p.message || p.summary || p.phase || ""}`.slice(0, 150);
    });
    await send(chatId, "📝 *Ultimi eventi:*\n" + lines.join("\n"));
}

async function _createChatSession(chatId, projectKey, st) {
    const proj = PROJECTS[projectKey];
    if (!proj) return send(chatId, "❌ Progetto sconosciuto.");
    try {
        const session = await createSession(proj.path);
        st.sessionId = session.id;
        subscribeEvents(proj.path);
        await send(chatId, `✅ Sessione \`${session.id.substring(0, 8)}…\` aperta su \`${projectKey}\`.\nOra puoi scrivere direttamente un task.`);
    } catch (e) {
        await send(chatId, `❌ ${e.message}`);
    }
}

async function _newCommand(chatId, msg, st) {
    // Kill loop if running
    if (loopProc) { try { loopProc.kill("SIGTERM"); } catch {} loopProc = null; }
    // Clear session
    if (st.sessionId) {
        try { await abortSession(st.sessionId, PROJECTS[st.project]?.path); } catch {}
    }
    // Delete tracked messages (both bot and user) + pinned + command message
    const toDelete = [];
    for (const m of (st.msgIds || [])) {
        toDelete.push(typeof m === "number" ? m : m.id);
    }
    if (st.pinnedMsgId) toDelete.push(st.pinnedMsgId);
    if (msg.message_id) toDelete.push(msg.message_id);
    // Also delete loop-tracked messages (from telegram-channel inside hydra-loop child process)
    try {
        const loopMsgPath = join(dirname(fileURLToPath(import.meta.url)), ".hydra", "loop-msg-ids.json");
        if (existsSync(loopMsgPath)) {
            const loopMsgs = JSON.parse(readFileSync(loopMsgPath, "utf-8"));
            for (const m of loopMsgs) {
                if (m.chatId === chatId) toDelete.push(m.id);
            }
        }
    } catch {}
    for (const mid of toDelete) {
        try { await tg("deleteMessage", { chat_id: chatId, message_id: mid }); } catch {}
    }
    // Clear loop message tracking file
    try {
        const loopMsgPath = join(dirname(fileURLToPath(import.meta.url)), ".hydra", "loop-msg-ids.json");
        writeFileSync(loopMsgPath, "[]");
    } catch {}
    // Reset ALL state
    st.sessionId = null;
    st.model = null;
    st.pinnedMsgId = null;
    st.wizard = null;
    st.msgIds = [];
    _saveChatState();
    startWizard(st);
    const wizardMsg = [
        "🆕 *Nuovo avvio* — loop fermato, cronologia cancellata.",
        "",
        "Cosa vuoi fare?",
        "",
        "1️⃣ Avviare Hydra Loop 24/7",
        "    Basato su Notion e backlog. Globale, non legato a un progetto.",
        "",
        "2️⃣ Aprire sessione chat",
        "    Lavora manualmente con opencode su un progetto specifico.",
        "",
        "3️⃣ Creare nuovo progetto",
        "    Aggiungi un progetto passo passo.",
        "",
        "Rispondi con il numero o il nome (es. 1, loop).",
        "Scrivi \`cancel\` per annullare.",
    ].join("\n");
    await send(chatId, wizardMsg);
}

async function _stopEverything(chatId, st, msg) {
    const results = [];

    // 1. Kill hydra-loop child process
    if (loopProc) {
        try { loopProc.kill("SIGTERM"); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        try { loopProc.kill("SIGKILL"); } catch {}
        loopProc = null;
        stopHeartbeatWatch();
        results.push("loop fermato");
    }

    // 2. Abort all active opencode sessions
    if (st.sessionId) {
        try { await abortSession(st.sessionId, PROJECTS[st.project]?.path); } catch {}
        st.sessionId = null;
        results.push("sessione abortita");
    }

    // 3. Kill opencode serve subprocess (and prevent auto-restart)
    if (opencodeProc) {
        opencodeProc.removeAllListeners("exit"); // prevent auto-restart
        try { opencodeProc.kill("SIGTERM"); } catch {}
        await new Promise(r => setTimeout(r, 500));
        try { opencodeProc.kill("SIGKILL"); } catch {}
        opencodeProc = null;
        healthOk = false;
        results.push("server opencode fermato");
    }

    // 4. Kill SSE subscription
    if (sseController) {
        sseController.abort();
        sseController = null;
    }

    // 5. Stop all typing timers
    for (const cid of Object.keys(typingTimers)) {
        stopTyping(Number(cid));
    }

    // 6. Clear loop message tracking
    try {
        const loopMsgPath = join(dirname(fileURLToPath(import.meta.url)), ".hydra", "loop-msg-ids.json");
        writeFileSync(loopMsgPath, "[]");
    } catch {}

    // 7. Delete loop signal files so WAIT_HUMAN can't auto-resume
    try {
        const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), ".hydra");
        const loopProjectPath = join(bridgeDir, "loop-project.json");
        if (existsSync(loopProjectPath)) {
            const lp = JSON.parse(readFileSync(loopProjectPath, "utf-8"));
            const hydraDir = join(lp.projectPath, ".hydra");
            const resumeSignal = join(hydraDir, "resume-signal.json");
            if (existsSync(resumeSignal)) writeFileSync(resumeSignal, JSON.stringify({}));
        }
    } catch {}

    // 8. Reset chat state
    st.sessionId = null;
    st.model = null;
    st.pinnedMsgId = null;
    st.wizard = null;
    st.msgIds = [];
    _saveChatState();

    // 9. Write stop sentinel for health check
    try {
        const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), ".hydra");
        writeFileSync(join(bridgeDir, "stopped"), String(Date.now()));
    } catch {}

    await send(chatId, "🛑 *Tutto fermo.*\n\nLoop disabilitato, server opencode spento, sessioni pulite.\nUsa /new per ripartire quando vuoi.");
}

async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text?.trim();
    if (!text || !userId) return;

    if (!ALLOWED_USERS.includes(userId)) {
        console.log(`[BLOCCATO] ${userId}`);
        return send(chatId, "⛔ Non autorizzato.");
    }

    console.log(`[${userId}] ${text.substring(0, 120)}`);
    const st = getState(chatId);

    // Track user message IDs too, so /new can delete them
    if (msg.message_id) _persistMsgId(chatId, msg.message_id, "user");
    
    const [cmd, ...rest] = text.split(/\s+/);
    const args = rest.join(" ");

    // These commands always work, even during a wizard
    if (cmd === "/new") return _newCommand(chatId, msg, st);
    if (cmd === "/loopstatus") return _loopStatus(chatId);
    if (cmd === "/log") return _logCommand(chatId, args, st);
    if (cmd === "/cancel") {
        if (st.wizard) {
            st.wizard = null;
            await send(chatId, "❌ Wizard annullato.");
        } else {
            await send(chatId, "⚠️ Nessun wizard attivo.");
        }
        return;
    }
    if (cmd === "/abort") {
        if (!st.sessionId) return send(chatId, "⚠️ Nessuna sessione attiva.");
        try {
            await abortSession(st.sessionId, PROJECTS[st.project]?.path);
            st.sessionId = null;
            await send(chatId, "⛏️ Sessione abortita.");
        } catch (e) {
            await send(chatId, "❌ " + e.message);
        }
        return;
    }

    if (cmd === "/stop") {
        return _stopEverything(chatId, st, msg);
    }

    // Handle wizard state
    if (st.wizard) {
        return handleWizard(chatId, text, st);
    }

    // HELP
    if (cmd === "/start" || cmd === "/help") {
        return send(
            chatId,
            [
                "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                "  🤖 *OPencode Telegram Bridge*",
                "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                "",
                "💬 *Scrivi un testo* → lo invia a opencode sul progetto attivo.",
                "",
                "━━── 🐍 HYDRALOOP 24/7 ──━━",
                "",
                "`/loop`          sottocomandi: start, stop, status, resume",
                "`/stop`          FERMA TUTTO (loop + server + sessioni)",
                "`/log [N]`       ultimi N eventi del loop attivo",
                "`/loopstatus`    stato completo del loop",
                "",
                "Il loop esegue idee da Notion in autonomia.",
                "Genera nuove idee e bugfix tramite scoperta automatica.",
                "",
                "━━── 📁 PROGETTI ──━━",
                "",
                "`/new`           wizard guidato: loop / chat / crea progetto",
                "`/project`       scegli progetto (pulsanti)",
                "`/projects`      elenca tutti i progetti",
                "`/notion`        test/configura connessione Notion",
                "",
                "━━── 🛠️  OPENCODE ──━━",
                "",
                "`/sessions`      sessioni opencode recenti",
                "`/status`        sessioni attive sul server",
                "`/model <nome>`  imposta modello AI",
                "`/stats`         statistiche di utilizzo",
                "`/shell cmd`     comando shell (solo comandi base)",
                "",
                "━━── ⚡ VELOCI ──━━",
                "",
                "`/cancel`        annulla wizard in corso",
                "`/abort`         ferma sessione opencode in esecuzione",
                "`/new`           pulisce tutto e riparte da zero",
            ].join("\n"),
        );
    }




    // SESSIONS
    if (cmd === "/sessions") {
        try {
            const sessions = await listSessions(PROJECTS[st.project]?.path);
            if (!sessions?.length) return send(chatId, "📭 Nessuna sessione.");
            const kb = sessions
                .slice(0, 15)
                .map((s) => [
                    {
                        text: `${s.title.substring(0, 35)} (${s.id.substring(0, 6)})`,
                        callback_data: `session:${s.id}`,
                    },
                ]);
            return tg("sendMessage", {
                chat_id: chatId,
                text: "📜 *Sessioni:*",
                parse_mode: "Markdown",
                reply_markup: inlineKeyboard(kb),
            });
        } catch (e) {
            return send(chatId, `❌ ${e.message}`);
        }
    }

    // PROJECT
    if (cmd === "/project" && !args) {
        const kb = Object.entries(PROJECTS).map(([k, v]) => [
            { text: `${k} — ${v.desc}`, callback_data: `project:${k}` },
        ]);
        return tg("sendMessage", {
            chat_id: chatId,
            text: "📁 *Progetto:*",
            parse_mode: "Markdown",
            reply_markup: inlineKeyboard(kb),
        });
    }
    if (cmd === "/project" && args) {
        if (PROJECTS[args]) {
            st.project = args;
            await send(chatId, `✅ Progetto: \`${args}\``);
            subscribeEvents(PROJECTS[args].path);
            return;
        }
        return send(chatId, "❌ Progetto sconosciuto.");
    }

    if (cmd === "/projects") {
        const list = Object.entries(PROJECTS)
            .map(([k, v]) => `  • \`${k}\` — ${v.desc}`)
            .join("\n");
        return send(
            chatId,
            `📂 *Progetti*\n${list}\n\nAttivo: \`${st.project}\``,
        );
    }

    // MODEL
    if (cmd === "/model" && !args) {
        return send(chatId, `🧠 Modello attuale: \`${st.model || "non impostato"}\``);
    }
    if (cmd === "/model" && args) {
        st.model = args;
        return send(chatId, `✅ Modello: \`${args}\``);
    }

    // STATS
    if (cmd === "/stats") {
        try {
            const home = homedir();
            const r = execSync("opencode stats 2>&1", {
                cwd: PROJECTS[st.project]?.path || home,
                timeout: 15000,
                env: {
                    ...process.env,
                    PATH: `${process.env.PATH || ""}:${join(home, ".opencode", "bin")}:${join(home, ".npm-global", "bin")}`,
                },
            }).toString();
            return send(chatId, codeBlock(r), { md: false });
        } catch (e) {
            return send(chatId, `❌ ${e.message}`);
        }
    }

    // SHELL - restricted to allowed commands
    if (cmd === "/shell" && args) {
        const allowedCommands = ["ls", "cat", "head", "tail", "grep", "find", "git", "npm", "node", "pnpm", "yarn", "bun"];
        const parts = args.trim().split(/\s+/);
        const baseCmd = parts[0];
        
        if (!allowedCommands.includes(baseCmd)) {
            return send(chatId, `⛔ Command not allowed. Allowed: ${allowedCommands.join(", ")}`);
        }
        
        try {
            const home = homedir();
            const r = execSync(args, {
                cwd: PROJECTS[st.project]?.path || home,
                timeout: 30000,
                shell: "/bin/bash",
                env: {
                    ...process.env,
                    PATH: `${process.env.PATH || ""}:${join(home, ".opencode", "bin")}:${join(home, ".npm-global", "bin")}`,
                },
            }).toString();
            return send(chatId, codeBlock(r.substring(0, 3500)), { md: false });
        } catch (e) {
            return send(
                chatId,
                "❌ " + codeBlock((e.stderr || e.message).substring(0, 2000)),
                { md: false },
            );
        }
    }

    // STATUS
    if (cmd === "/status") {
        try {
            const status = await getSessionStatus(PROJECTS[st.project]?.path);
            const txt = Object.entries(status || {})
                .map(([id, s]) => `  • \`${id.substring(0, 8)}…\`: ${s.type}`)
                .join("\n");
            return send(
                chatId,
                `📊 *Sessioni attive:*\n${txt || "  nessuna"}\n\nProgetto: \`${st.project}\`\nSessione: \`${(st.sessionId || "—").substring(0, 8)}…\``,
            );
        } catch (e) {
            return send(chatId, `❌ ${e.message}`);
        }
    }

    
    // ── NOTION ─────────────────────────────────────────────────────
    if (cmd === "/notion") {
        const token = process.env.NOTION_API_TOKEN;
        if (!token) return send(chatId, "📝 *Notion* non configurato.\nAggiungi NOTION_API_TOKEN nel .env");
        startTyping(chatId);
        try {
            const r = execSync("ntn --version 2>&1 && echo '---' && ntn api v1/users/me 2>&1", {
                timeout: 15000, env: { ...process.env, NOTION_API_TOKEN: token },
            }).toString();
            stopTyping(chatId);
            return send(chatId, "📝 *Notion connesso!*\n" + codeBlock(r.slice(0, 2000)), { md: false });
        } catch (e) {
            stopTyping(chatId);
            return send(chatId, "❌ Notion: " + (e.stderr || e.message).toString().slice(0, 500), { md: false });
        }
    }

    // ── LOOP CONTROL 24/7 ──────────────────────────────────────────
    if (cmd === "/loop" && !args) {
        const kb = inlineKeyboard([
            [{ text: "▶️ Start", callback_data: "loop:start" }],
            [{ text: "🔄 Resume", callback_data: "loop:resume" }],
            [{ text: "📊 Status", callback_data: "loop:status" }],
            [{ text: "⛔ Stop", callback_data: "loop:stop" }],
        ]);
        return tg("sendMessage", {
            chat_id: chatId,
            text: "🐍 *Hydra Loop* — scegli un'azione:",
            parse_mode: "Markdown",
            reply_markup: kb,
        });
    }
    if (cmd === "/loop" && args === "start") {
        return _startLoop(chatId);
    }
    if (cmd === "/loop" && args === "stop") {
        if (loopProc) { try { loopProc.kill("SIGTERM"); } catch {} loopProc = null; stopHeartbeatWatch(); await send(chatId, "⛔ Hydra Loop fermato."); }
        else { await send(chatId, "⚠️ Nessun loop attivo."); }
        return;
    }
    if (cmd === "/loop" && args === "status") {
        return _loopStatus(chatId);
    }
    if (cmd === "/loop" && args === "resume") {
        const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), ".hydra");
        let projectPath = null;
        try {
            const lp = JSON.parse(readFileSync(join(bridgeDir, "loop-project.json"), "utf-8"));
            projectPath = lp.projectPath;
        } catch {
            return send(chatId, "❌ Nessun progetto loop trovato in .hydra/loop-project.json");
        }
        const hydraDir = join(projectPath, ".hydra");
        await mkdir(hydraDir, { recursive: true }).catch(() => {});
        const signalPath = join(hydraDir, "resume-signal.json");
        await writeFile(signalPath, JSON.stringify({ resumeAt: new Date().toISOString(), requestId: "manual-resume", decision: "resume" }, null, 2));
        if (loopProc) {
            await send(chatId, "✅ Segnale di resume inviato al loop. Dovrebbe ripartire a breve.");
        } else {
            await send(chatId, "✅ Segnale di resume scritto. Avvia il loop con /loop start se non è già in esecuzione.");
        }
        return;
    }
    if (cmd === "/loopstatus") {
        return _loopStatus(chatId);
    }


// TASK DI CODING (default)
    await executeTask(chatId, text, st);
}

async function executeTask(chatId, text, st) {
    const proj = PROJECTS[st.project];
    if (!proj) return send(chatId, "❌ Progetto sconosciuto.");

    try {
        // Crea sessione se non esiste
        if (!st.sessionId) {
            await send(chatId, `🆕 Nuova sessione in \`${st.project}\`...`);
            const session = await createSession(proj.path);
            st.sessionId = session.id;
            subscribeEvents(proj.path);
        }
    } catch (e) {
        return send(chatId, `❌ ${e.message}`);
    }

    await send(
        chatId,
        `🧩 *Esecuzione…*  \`${st.project}\`  ·  sessione \`${st.sessionId.substring(0, 8)}…\``,
    );
    sendAction(chatId);

    try {
        const result = await sendPrompt(st.sessionId, text, proj.path);
        const output =
            typeof result === "object"
                ? JSON.stringify(result, null, 2)
                : String(result || "");

        // Estrai il testo della risposta
        let replyText = "";
        if (result?.parts) {
            replyText = result.parts
                .map((p) => p.text || "")
                .join("\n")
                .trim();
        }

        if (replyText) {
            await send(
                chatId,
                `✅ *Risposta:*\n\n${codeBlock(replyText.substring(0, 3500))}`,
            );
            if (replyText.length > 3500) {
                const rest = replyText.substring(3500);
                for (let i = 0; i < rest.length; i += 3500) {
                    await send(chatId, codeBlock(rest.substring(i, i + 3500)), { md: false });
                }
            }
        } else {
            await send(
                chatId,
                `✅ *Completato*\n${codeBlock(output.substring(0, 2000))}`,
                { md: false },
            );
        }
    } catch (e) {
        await send(chatId, `❌ ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════
// CALLBACK
// ═══════════════════════════════════════════════════════════════════

async function handleCallback(query) {
    const chatId = query.message.chat.id;
    const userId = query.from?.id;
    const msgId = query.message.message_id;
    const data = query.data;
    if (!ALLOWED_USERS.includes(userId)) {
        return tg("answerCallbackQuery", {
            callback_query_id: query.id,
            text: "⛔ Non autorizzato",
        });
    }
    await tg("answerCallbackQuery", { callback_query_id: query.id });
    const [action, ...rest] = data.split(":");
    const value = rest.join(":");
    const st = getState(chatId);

    if (action === "project" && PROJECTS[value]) {
        st.project = value;
        st.sessionId = null;
        subscribeEvents(PROJECTS[value].path);
        await tg("editMessageText", {
            chat_id: chatId,
            message_id: msgId,
            text: `✅ Progetto: \`${value}\``,
            parse_mode: "Markdown",
        });
    }

    if (action === "session") {
        st.sessionId = value;
        await tg("editMessageText", {
            chat_id: chatId,
            message_id: msgId,
            text: `✅ Sessione: \`${value.substring(0, 8)}…\``,
            parse_mode: "Markdown",
        });
    }

    if (action === "loop") {
        const label = { start: "▶️ Start", resume: "🔄 Resume", status: "📊 Status", stop: "⛔ Stop" };
        await tg("editMessageText", {
            chat_id: chatId,
            message_id: msgId,
            text: `🐍 *Loop:* \`${label[value] || value}\`...`,
            parse_mode: "Markdown",
        });
        // Dispatch the action via the message handler
        const fakeMsg = { chat: { id: chatId }, from: { id: userId }, text: `/loop ${value}`, message_id: msgId };
        handleMessage(fakeMsg).catch(e => console.error("loop callback err:", e.message));
    }

    if (action === "hydra") {
        const cmd = rest[0];
        await tg("editMessageText", {
            chat_id: chatId,
            message_id: msgId,
            text: `✅ Comando inviato: \`${cmd}\``,
            parse_mode: "Markdown",
        });
        
        const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), ".hydra");
        let projectPath = null;
        try {
            const lp = JSON.parse(readFileSync(join(bridgeDir, "loop-project.json"), "utf-8"));
            projectPath = lp.projectPath;
        } catch { projectPath = join(homedir(), "projects", "loop"); }
        
        if (cmd === "resume") {
            const pausedPath = join(projectPath, ".hydra", "paused-projects.json");
            try {
                const paused = JSON.parse(readFileSync(pausedPath, "utf-8"));
                for (const slug of Object.keys(paused)) {
                    const p = join(projectPath, "projects", slug, ".hydra");
                    if (!existsSync(p)) mkdirSync(p, { recursive: true });
                    writeFileSync(join(p, "resume-signal.json"), JSON.stringify({ ts: Date.now() }));
                }
            } catch {}
        } else {
            const signalPath = join(projectPath, ".hydra", "human-signal.json");
            try { writeFileSync(signalPath, JSON.stringify({ action: cmd, args: rest.slice(1), ts: Date.now() })); } catch {}
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════════════════

const typingTimers = {};

// ─── Heartbeat monitoring for child hydra-loop process ───
let heartbeatWatchTimer = null;
function startHeartbeatWatch() {
    if (heartbeatWatchTimer) clearInterval(heartbeatWatchTimer);
    heartbeatWatchTimer = setInterval(async () => {
        if (!loopProc) return;
        const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), ".hydra");
        let projectPath = null;
        try {
            const lp = JSON.parse(readFileSync(join(bridgeDir, "loop-project.json"), "utf-8"));
            projectPath = lp.projectPath;
        } catch { projectPath = join(homedir(), "projects", "loop"); }
        const hbPath = join(projectPath, ".hydra", "heartbeat");
        try {
            const raw = readFileSync(hbPath, "utf-8");
            const hb = JSON.parse(raw);
            const age = Date.now() - hb.ts;
            if (age > 120_000 && loopProc) {
                console.error(`[heartbeat] LOOP STALLED — no heartbeat for ${Math.round(age/1000)}s, phase: ${hb.phase}`);
            }
        } catch {
            if (loopProc) {
                console.error("[heartbeat] heartbeat file missing — loop may have crashed");
            }
        }
    }, 30000);
}

function stopHeartbeatWatch() {
    if (heartbeatWatchTimer) {
        clearInterval(heartbeatWatchTimer);
        heartbeatWatchTimer = null;
    }
}

function startTyping(chatId) {
    stopTyping(chatId);
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    typingTimers[chatId] = setInterval(() => {
        tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(
            () => {},
        );
    }, 4000);
}

function stopTyping(chatId) {
    if (typingTimers[chatId]) {
        clearInterval(typingTimers[chatId]);
        delete typingTimers[chatId];
    }
}

let offset = 0;

async function poll() {
    try {
        const data = await tg("getUpdates", {
            offset,
            timeout: 30,
            allowed_updates: ["message", "callback_query"],
        });
        if (data.ok && data.result) {
            for (const upd of data.result) {
                offset = upd.update_id + 1;
                if (upd.callback_query)
                    await handleCallback(upd.callback_query).catch((e) =>
                        console.error("cb err:", e.message),
                    );
                else if (upd.message)
                    await handleMessage(upd.message).catch((e) =>
                        console.error("msg err:", e.message),
                    );
            }
        }
    } catch (err) {
        console.error("poll error:", err.message);
    }
    setTimeout(poll, 300);
}

// ═══════════════════════════════════════════════════════════════════
// AVVIO
// ═══════════════════════════════════════════════════════════════════

console.log("╔══════════════════════════════════════════╗");
console.log("║  OpenCode Telegram Bridge v3             ║");
console.log("║  Streaming live via API server           ║");
console.log("╚══════════════════════════════════════════╝");

startOpencode();
startHealthServer();
const ready = await waitForHealth();

if (ready) {
    subscribeEvents(dirname(fileURLToPath(import.meta.url)));
    poll();
} else {
    console.error("❌ Impossibile avviare opencode serve");
    process.exit(1);
}

// Registra comandi Telegram
const cmds = [
    ["help", "Aiuto — lista completa comandi"],
    ["new", "Wizard: loop 24/7 / chat / crea progetto"],
    ["cancel", "Annulla wizard in corso"],
    ["stop", "Ferma TUTTO (loop + server + sessioni)"],
    ["loop", "Menu loop: start, stop, status, resume"],
    ["loopstatus", "Stato completo del Hydra Loop"],
    ["log", "Ultimi eventi del loop"],
    ["abort", "Ferma sessione opencode in corso"],
    ["sessions", "Sessioni opencode recenti"],
    ["status", "Sessioni attive sul server"],
    ["project", "Cambia progetto attivo"],
    ["projects", "Lista progetti disponibili"],
    ["model", "Mostra/imposta modello AI"],
    ["stats", "Statistiche di utilizzo"],
    ["shell", "Comando shell (base)"],
    ["notion", "Test connessione Notion"],
];
await tg("setMyCommands", {
    commands: cmds.map(([c, d]) => ({ command: c, description: d })),
}).catch(() => {});
console.log("📋 Comandi registrati");
