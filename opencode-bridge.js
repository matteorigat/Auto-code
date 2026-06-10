#!/usr/bin/env node
/**
 * OpenCode Telegram Bridge v2 — Interfaccia 1:1 con opencode
 *
 * Caratteristiche:
 *  - Tutti i comandi opencode via Telegram (/models, /stats, /continue, …)
 *  - Tastiere inline per selezione (progetti, modelli, agenti)
 *  - Indicatore "sta scrivendo" persistente durante esecuzione
 *  - Output spezzato in messaggi multipli se lungo
 *  - Riavvio automatico del long-polling in caso di errore
 *
 * Uso:
 *   export TELEGRAM_BOT_TOKEN="..."
 *   node opencode-bridge.js
 */

// ═══════════════════════════════════════════════════════════════════
// CONFIGURAZIONE
// ═══════════════════════════════════════════════════════════════════

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
    console.error("ERRORE: imposta TELEGRAM_BOT_TOKEN (da @BotFather)");
    process.exit(1);
}

const PROJECTS = {
    neo: { path: "/home/ubuntu/projects/neo", desc: "Next.js Neo" },
    dashboard: {
        path: "/home/ubuntu/projects/openclaw-dashboard",
        desc: "OpenClaw Dashboard",
    },
    "openclaw-dashboard": {
        path: "/home/ubuntu/projects/openclaw-dashboard",
        desc: "OpenClaw Dashboard",
    },
    "api-models": {
        path: "/home/ubuntu/projects/api-models-check",
        desc: "API Models Check",
    },
    "model-dashboard": {
        path: "/home/ubuntu/projects/model-dashboard",
        desc: "Model Dashboard",
    },
};

// ── Solo questi utenti Telegram possono usare il bot ───────────────
// Formato: [id: numero, ...]
// Per trovare il tuo ID, scrivi /start al bot e guarda i log
const ALLOWED_USERS = [***REMOVED***]; // ← il tuo ID Telegram

const DEFAULT_PROJECT = process.env.OPENCODE_DEFAULT_PROJECT || "neo";
const DEFAULT_MODEL =
    process.env.OPENCODE_DEFAULT_MODEL ||
    "openai/tier-4-planner";
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

// ═══════════════════════════════════════════════════════════════════
// STATO
// ═══════════════════════════════════════════════════════════════════

/** @type {Record<number, { project:string, model:string, lastSessionId?:string }>} */
const chatState = {};

function getState(chatId) {
    if (!chatState[chatId]) {
        chatState[chatId] = { project: DEFAULT_PROJECT, model: DEFAULT_MODEL };
    }
    return chatState[chatId];
}

// ═══════════════════════════════════════════════════════════════════
// API TELEGRAM
// ═══════════════════════════════════════════════════════════════════

async function tg(method, payload = {}) {
    const url = `${TG_API}/${method}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    return res.json();
}

/** Invia un messaggio gestendo Markdown e limite 4000 caratteri */
async function send(chatId, text, opt = {}) {
    if (!text) text = "✅ Fatto.";
    const MAX = 4000;
    const chunks = [];
    while (text.length > MAX) {
        // taglia all'ultimo newline entro MAX
        let cut = text.lastIndexOf("\n", MAX);
        if (cut < MAX / 2) cut = MAX; // arranchina se no newline decente
        chunks.push(text.slice(0, cut));
        text = text.slice(cut).trim();
    }
    if (text) chunks.push(text);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Se è l'ultimo chunk e ha parse_mode Markdown, wah
        const useMD =
            opt.md !== false &&
            !chunk.includes("❌") &&
            !chunk.startsWith("```");
        await tg("sendMessage", {
            chat_id: chatId,
            text: chunk,
            parse_mode: useMD ? "Markdown" : undefined,
            disable_web_page_preview: true,
            reply_to_message_id: i === 0 ? opt.replyTo : undefined,
        });
    }
}

/** Notifica "sta scrivendo" ogni 5 secondi finché active=true */
let typingIntervals = {};

function startTyping(chatId) {
    stopTyping(chatId);
    sendAction(chatId); // immediato
    typingIntervals[chatId] = setInterval(() => sendAction(chatId), 4000);
}

function stopTyping(chatId) {
    if (typingIntervals[chatId]) {
        clearInterval(typingIntervals[chatId]);
        delete typingIntervals[chatId];
    }
}

async function sendAction(chatId, action = "typing") {
    try {
        await tg("sendChatAction", { chat_id: chatId, action });
    } catch (_) {
        /* ignore */
    }
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════

function codeBlock(text, lang = "") {
    return "```" + lang + "\n" + text.replace(/```/g, "'''") + "\n```";
}

function inlineKeyboard(rows) {
    return JSON.stringify({ inline_keyboard: rows });
}

function run(cmd, opts = {}) {
    const { execSync } = require("child_process");
    return execSync(cmd, {
        cwd: opts.cwd || "/home/ubuntu",
        timeout: opts.timeout || 600_000, // 10 min default
        maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
        shell: "/bin/bash",
        env: {
            ...process.env,
            OPENCODE_ENABLE_EXA: "1",
            OPENCODE_EXPERIMENTAL_LSP_TOOL: "true",
            HOME: process.env.HOME,
            PATH: "/home/ubuntu/.opencode/bin:/home/ubuntu/.npm-global/bin:/usr/bin:/bin:/usr/local/bin",
        },
        ...opts.spawnOpts,
    }).toString();
}

function tryRun(cmd, opts = {}) {
    try {
        return { ok: true, out: run(cmd, opts) };
    } catch (e) {
        const out = (e.stdout || "") + "\n" + (e.stderr || "");
        return { ok: false, out: out.trim() || e.message };
    }
}

// Parsing progetto inline: @progetto, nel progetto X
function detectProject(text) {
    const lower = text.toLowerCase();
    const at = lower.match(/@(\w[\w-]*)/);
    if (at && PROJECTS[at[1]]) return at[1];
    const phrase = lower.match(/(?:nel|sul|per)\s+progetto\s+(\w[\w-]*)/);
    if (phrase && PROJECTS[phrase[1]]) return phrase[1];
    return null;
}

function stripProject(text, proj) {
    return text
        .replace(new RegExp(`@${proj}\\s*:?\\s*`, "i"), "")
        .replace(
            new RegExp(`(nel|sul|per)\\s+progetto\\s+${proj}\\s*`, "i"),
            "",
        )
        .trim();
}

// ═══════════════════════════════════════════════════════════════════
// ESECUZIONE OPENCODE
// ═══════════════════════════════════════════════════════════════════

async function execOpencode(chatId, task, opts = {}) {
    const st = getState(chatId);
    const projKey = opts.project || st.project;
    const proj = PROJECTS[projKey];
    if (!proj) {
        await send(chatId, `❌ Progetto sconosciuto: \`${projKey}\``);
        return;
    }

    const model = opts.model || st.model;
    const continueFlag = opts.continue ? " --continue" : "";
    const agentFlag = opts.agent ? ` --agent ${opts.agent}` : "";
    const cmd = `opencode run${continueFlag}${agentFlag} --model ${model} ${JSON.stringify(task)}`;

    // Messaggio di avvio
    await send(
        chatId,
        `🧩 *Esecuzione…*  ·  \`${projKey}\`  ·  \`${model.split("/").pop()}\`\n` +
            codeBlock(task.substring(0, 500)),
    );

    // "sta scrivendo" ogni 4 secondi
    startTyping(chatId);

    const result = tryRun(cmd, { cwd: proj.path, timeout: 600_000 });

    // Ferma typing
    stopTyping(chatId);

    // Salva session ID se presente
    const sidMatch = result.out.match(/session[:\s]+([a-zA-Z0-9_-]+)/i);
    if (sidMatch) st.lastSessionId = sidMatch[1];

    const header = result.ok ? "✅ *Completato*" : "❌ *Errore*";
    const body = result.out.substring(0, 3500);

    await send(chatId, `${header}  ·  \`${projKey}\`\n\n${codeBlock(body)}`);

    // Se l'output era più lungo, manda il resto in un secondo messaggio
    if (result.out.length > 3500) {
        await send(chatId, codeBlock(result.out.substring(3500, 7000)));
    }

    // Se c'è stato un errore e opencode ha lasciato output su stderr
    if (!result.ok && result.out.length > 7000) {
        await send(
            chatId,
            `⚠️ Output troppo lungo (${result.out.length} caratteri). Mostrati i primi 7000.`,
        );
    }
}

// ═══════════════════════════════════════════════════════════════════
// COMANDI
// ═══════════════════════════════════════════════════════════════════

const COMMANDS = {
    help() {
        return {
            text: [
                "🤖 *OpenCode Bridge* — Interfaccia Telegram 1:1",
                "",
                "🎯 *Coding*",
                "Qualsiasi messaggio → `opencode run`",
                "`@progetto: task` → esegue su progetto specifico",
                "`/continue task` → continua ultima sessione",
                "",
                "⚙️ *Comandi opencode*",
                "`/models`      elenca modelli",
                "`/model`       seleziona modello (tastiera)",
                "`/providers`   elenca provider",
                "`/stats`       token e costi",
                "`/version`     versione opencode",
                "`/sessions`    sessioni recenti",
                "`/export [id]` esporta sessione JSON",
                "`/agent`       seleziona agente",
                "`/config`      mostra configurazione",
                "",
                "📁 *Progetti*",
                "`/project`     cambia progetto (tastiera)",
                "`/projects`    lista progetti",
                "",
                "🖥️ *Shell*",
                "`/shell cmd`   esegui comando raw",
                "",
                "*Esempi:*",
                "`@neo: aggiungi test per config.go`",
                "`/model openai/tier-4-planner`",
                "`/continue refactoring variabili`",
                "`/shell git log --oneline -5`",
            ].join("\n"),
            kb: false,
        };
    },

    async models(chatId) {
        startTyping(chatId);
        const r = tryRun("opencode models 2>&1 | head -80");
        stopTyping(chatId);
        if (!r.ok) return { text: "❌ " + r.out, md: false };
        return {
            text:
                "📋 *Modelli disponibili* (prime 80 righe):\n" +
                codeBlock(r.out),
        };
    },

    async modelPick(chatId) {
        startTyping(chatId);
        const r = tryRun("opencode models 2>&1 | head -40");
        stopTyping(chatId);
        if (!r.ok) return { text: "❌ " + r.out, md: false };

        const models = r.out
            .split("\n")
            .filter(
                (l) =>
                    l.trim() &&
                    !l.startsWith("─") &&
                    !l.startsWith("═") &&
                    !l.startsWith("*"),
            )
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 30);
        const kb = models.map((m) => [
            {
                text: m.length > 40 ? m.substring(0, 38) + "…" : m,
                callback_data: `model:${m}`,
            },
        ]);
        // Aggiungi modelli del pool LiteLLM in cima
        kb.unshift([
            {
                text: "Tier 4: Complex Planning",
                callback_data: "model:openai/tier-4-planner",
            },
        ]);
        kb.unshift([
            {
                text: "Tier 3: Coding & QA",
                callback_data: "model:openai/tier-3-builder",
            },
        ]);
        kb.unshift([
            {
                text: "Tier 2: Bug Hunter",
                callback_data: "model:openai/tier-2-hunter",
            },
        ]);
        kb.unshift([
            {
                text: "Tier 1: Trivial Tasks",
                callback_data: "model:openai/tier-1-trivial",
            },
        ]);

        return {
            text: "🤖 *Seleziona modello:*",
            kb,
        };
    },

    async providers(chatId) {
        startTyping(chatId);
        const r = tryRun("opencode providers list 2>&1");
        stopTyping(chatId);
        const text = r.ok
            ? "🔌 *Provider:*\n" + codeBlock(r.out.substring(0, 3000))
            : "❌ " + r.out;
        return { text, md: false, kb: false };
    },

    async stats(chatId) {
        startTyping(chatId);
        const r = tryRun("opencode stats 2>&1");
        stopTyping(chatId);
        return {
            text: r.ok ? codeBlock(r.out) : "❌ " + r.out,
            md: false,
            kb: false,
        };
    },

    async version() {
        const r = tryRun("opencode --version 2>&1");
        const v = r.ok ? r.out.trim() : "errore";
        return { text: `🔢 *OpenCode* \`${v}\`` };
    },

    async sessions(chatId) {
        startTyping(chatId);
        const r = tryRun("opencode session list 2>&1; opencode sessions 2>&1", {
            timeout: 15000,
        });
        stopTyping(chatId);
        if (r.ok) {
            return {
                text: "📜 *Sessioni:*\n" + codeBlock(r.out.substring(0, 3000)),
                kb: false,
            };
        }
        return { text: "📜 Nessuna sessione trovata.", kb: false };
    },

    async config(chatId) {
        const st = getState(chatId);
        const proj = PROJECTS[st.project];
        startTyping(chatId);
        const r = tryRun(
            "cat .opencode/opencode.json 2>/dev/null || echo 'nessun file .opencode/opencode.json'",
            {
                cwd: proj?.path || "/home/ubuntu",
            },
        );
        stopTyping(chatId);
        return {
            text: `⚙️ *Config* (\`${st.project}\`):\n${codeBlock(r.out.substring(0, 3000))}`,
        };
    },

    async agentPick(chatId) {
        startTyping(chatId);
        const r = tryRun("opencode agent list 2>&1");
        stopTyping(chatId);
        if (!r.ok) return { text: "❌ " + r.out, md: false };

        const agents = r.out
            .split("\n")
            .filter((l) => l.trim() && l.includes("("))
            .map((l) => l.trim());
        const kb = agents.map((a) => {
            const name = a.split(" ")[0].split("(")[0].trim();
            return [
                {
                    text: a.length > 40 ? a.substring(0, 38) + "…" : a,
                    callback_data: `agent:${name}`,
                },
            ];
        });
        if (kb.length === 0) {
            kb.push([
                { text: "build (default)", callback_data: "agent:build" },
            ]);
            kb.push([{ text: "plan", callback_data: "agent:plan" }]);
            kb.push([{ text: "explore", callback_data: "agent:explore" }]);
        }
        return { text: "🤖 *Seleziona agente:*", kb };
    },

    async projectPick(chatId) {
        const kb = Object.entries(PROJECTS).map(([key, val]) => [
            { text: `${key} — ${val.desc}`, callback_data: `project:${key}` },
        ]);
        return { text: "📁 *Seleziona progetto:*", kb };
    },

    async exportSession(chatId, args) {
        startTyping(chatId);
        const sid = args || chatState[chatId]?.lastSessionId;
        if (!sid) {
            stopTyping(chatId);
            return {
                text: "⚠️ Nessuna sessione da esportare. Usa `/export <sessionId>`",
            };
        }
        const r = tryRun(`opencode export ${sid} 2>&1`, { timeout: 30000 });
        stopTyping(chatId);
        if (r.ok) {
            return {
                text: `📦 *Sessione ${sid}:*\n${codeBlock(r.out.substring(0, 3000))}`,
                kb: false,
            };
        }
        return { text: "❌ " + r.out, md: false, kb: false };
    },

    async shell(chatId, args, st) {
        if (!args) return { text: "ℹ️ Usa: `/shell <comando>`" };
        startTyping(chatId);
        const proj = PROJECTS[st.project];
        await send(chatId, `🖥️ \`${args.substring(0, 200)}\``);
        const r = tryRun(args, {
            cwd: proj?.path || "/home/ubuntu",
            timeout: 120_000,
        });
        stopTyping(chatId);
        return {
            text: r.ok
                ? codeBlock(r.out.substring(0, 3500))
                : "❌ " + codeBlock(r.out.substring(0, 2000)),
            md: false,
            kb: false,
        };
    },
};

// ═══════════════════════════════════════════════════════════════════
// CALLBACK QUERY (pulsanti inline)
// ═══════════════════════════════════════════════════════════════════

async function handleCallback(query) {
    const chatId = query.message.chat.id;
    const userId = query.from?.id;
    const msgId = query.message.message_id;
    const data = query.data;

    // Blocca utenti non autorizzati
    if (!isAllowed(userId)) {
        console.log(
            `[BLOCCATO] Callback da utente ${userId} (@${query.from?.username || "?"}): ${data}`,
        );
        await tg("answerCallbackQuery", {
            callback_query_id: query.id,
            text: "⛔ Non autorizzato",
        });
        return;
    }
    const [action, ...rest] = data.split(":");
    const value = rest.join(":");
    const st = getState(chatId);

    // Rispondi subito al callback per far sparire l'orologio
    await tg("answerCallbackQuery", { callback_query_id: query.id });

    switch (action) {
        case "project":
            if (PROJECTS[value]) {
                st.project = value;
                await tg("editMessageText", {
                    chat_id: chatId,
                    message_id: msgId,
                    text: `✅ Progetto attivo: \`${value}\` — ${PROJECTS[value].desc}`,
                    parse_mode: "Markdown",
                });
            }
            break;

        case "model":
            st.model = value;
            await tg("editMessageText", {
                chat_id: chatId,
                message_id: msgId,
                text: `✅ Modello impostato: \`${value}\``,
                parse_mode: "Markdown",
            });
            break;

        case "agent":
            await tg("editMessageText", {
                chat_id: chatId,
                message_id: msgId,
                text: `✅ Agente selezionato. Usalo con \`@${value}: task\` o \`/run --agent ${value} task\``,
                parse_mode: "Markdown",
            });
            break;

        default:
            await tg("editMessageText", {
                chat_id: chatId,
                message_id: msgId,
                text: `❌ Comando sconosciuto: ${data}`,
            });
    }
}

// ═══════════════════════════════════════════════════════════════════
// GESTIONE MESSAGGI
// ═══════════════════════════════════════════════════════════════════

// ── Autorizzazione ──────────────────────────────────────────────────
function isAllowed(userId) {
    return ALLOWED_USERS.includes(userId);
}

async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text?.trim();
    if (!text || !userId) return;

    // Blocca utenti non autorizzati
    if (!isAllowed(userId)) {
        console.log(
            `[BLOCCATO] Tentativo da utente ${userId} (@${msg.from.username || "?"}): ${text.substring(0, 100)}`,
        );
        await send(chatId, "⛔ Non sei autorizzato a usare questo bot.");
        return;
    }

    console.log(`[${userId}] ${text.substring(0, 150)}`);
    const st = getState(chatId);

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    // HELP / START
    if (cmd === "/start" || cmd === "/help") {
        const h = COMMANDS.help();
        return send(chatId, h.text);
    }

    // MODEL senza args → tastiera
    if (cmd === "/model" && !args) {
        const r = await COMMANDS.modelPick(chatId);
        return tg("sendMessage", {
            chat_id: chatId,
            text: r.text,
            parse_mode: "Markdown",
            reply_markup: r.kb ? inlineKeyboard(r.kb) : undefined,
        });
    }

    // MODEL con args → set diretto
    if (cmd === "/model" && args) {
        st.model = args;
        return send(chatId, `✅ Modello impostato: \`${args}\``);
    }

    // PROJECT senza args → tastiera
    if (cmd === "/project" && !args) {
        const r = await COMMANDS.projectPick(chatId);
        return tg("sendMessage", {
            chat_id: chatId,
            text: r.text,
            parse_mode: "Markdown",
            reply_markup: inlineKeyboard(r.kb),
        });
    }

    // PROJECT con args
    if (cmd === "/project" && args) {
        if (PROJECTS[args]) {
            st.project = args;
            return send(
                chatId,
                `✅ Progetto attivo: \`${args}\` — ${PROJECTS[args].desc}`,
            );
        }
        const list = Object.entries(PROJECTS)
            .map(([k, v]) => `  • \`${k}\` — ${v.desc}`)
            .join("\n");
        return send(chatId, `❌ Progetto \`${args}\` non trovato.\n${list}`);
    }

    // PROJECTS
    if (cmd === "/projects") {
        const r = await COMMANDS.projectPick(chatId);
        return tg("sendMessage", {
            chat_id: chatId,
            text: r.text + `\n\nAttivo: \`${st.project}\``,
            parse_mode: "Markdown",
            reply_markup: inlineKeyboard(r.kb),
        });
    }

    // CONTINUE
    if (cmd === "/continue") {
        return execOpencode(chatId, args || "continua", { continue: true });
    }

    // RUN esplicito
    if (cmd === "/run" && args) {
        return execOpencode(chatId, args);
    }

    // SHELL
    if (cmd === "/shell") {
        const r = await COMMANDS.shell(chatId, args, st);
        return send(chatId, r.text, { md: r.md !== false });
    }

    // EXPORT
    if (cmd === "/export") {
        const r = await COMMANDS.exportSession(chatId, args);
        return send(chatId, r.text, { md: r.md !== false, kb: false });
    }

    // AGENT senza args → tastiera
    if (cmd === "/agent" && !args) {
        const r = await COMMANDS.agentPick(chatId);
        return tg("sendMessage", {
            chat_id: chatId,
            text: r.text,
            parse_mode: "Markdown",
            reply_markup: r.kb ? inlineKeyboard(r.kb) : undefined,
        });
    }

    // AGENT con args
    if (cmd === "/agent" && args) {
        return send(
            chatId,
            `ℹ️ Usa \`@${args}: task\` per usare l'agente \`${args}\``,
        );
    }

    // Comandi delegati a opencode CLI
    const delegati = {
        "/models": "modelPick",
        "/providers": "providers",
        "/stats": "stats",
        "/version": "version",
        "/sessions": "sessions",
        "/config": "config",
    };

    if (delegati[cmd]) {
        const handler = COMMANDS[delegati[cmd]];
        const r = await handler(chatId, args);
        const payload = {
            chat_id: chatId,
            text: r.text,
            parse_mode: r.md !== false ? "Markdown" : undefined,
            disable_web_page_preview: true,
        };
        if (r.kb) payload.reply_markup = inlineKeyboard(r.kb);
        return tg("sendMessage", payload);
    }

    // Task di coding (default)
    const inlineProj = detectProject(text);
    const projectKey = inlineProj || st.project;
    const cleanTask = inlineProj ? stripProject(text, inlineProj) : text;

    if (!PROJECTS[projectKey]) {
        return send(
            chatId,
            `❌ Progetto \`${projectKey}\` sconosciuto. Usa /projects`,
        );
    }

    if (cmd.startsWith("/")) {
        return send(chatId, `❌ Comando sconosciuto: \`${cmd}\`\nUsa /help`);
    }

    await execOpencode(chatId, cleanTask, { project: projectKey });
}

// ═══════════════════════════════════════════════════════════════════
// LONG POLLING
// ═══════════════════════════════════════════════════════════════════

let offset = 0;

async function poll() {
    let data;
    try {
        data = await tg("getUpdates", {
            offset,
            timeout: 30,
            allowed_updates: ["message", "callback_query"],
        });
    } catch (err) {
        console.error("poll fetch error:", err.message);
        setTimeout(poll, 3000);
        return;
    }

    if (data.ok && data.result) {
        for (const upd of data.result) {
            offset = upd.update_id + 1;
            try {
                if (upd.callback_query) {
                    await handleCallback(upd.callback_query);
                } else if (upd.message) {
                    await handleMessage(upd.message);
                }
            } catch (err) {
                console.error("handleUpdate error:", err.message);
            }
        }
    } else if (data && !data.ok) {
        console.error(
            "poll API error:",
            data.description || JSON.stringify(data),
        );
        // Se il token non è valido, non continuare a spammare
        if (data.error_code === 401) {
            console.error("❌ Token non valido! Fermo il polling.");
            return;
        }
    }

    // Piccolo delay prima del prossimo poll
    setTimeout(poll, 300);
}

// ═══════════════════════════════════════════════════════════════════
// AVVIO
// ═══════════════════════════════════════════════════════════════════

console.log("╔══════════════════════════════════════════╗");
console.log("║   OpenCode Telegram Bridge v2            ║");
console.log("║   Interfaccia 1:1 con opencode           ║");
console.log("╚══════════════════════════════════════════╝");
console.log(`📁 Default: ${DEFAULT_PROJECT}`);
console.log(`🤖 Default: ${DEFAULT_MODEL}`);
console.log("👀 In attesa di messaggi... (long-polling)");

// ── Registra comandi su Telegram ─────────────────────────────────
(async () => {
    const cmds = [
        ["help", "Mostra tutti i comandi disponibili"],
        ["models", "Elenca modelli disponibili"],
        ["model", "Seleziona modello predefinito"],
        ["providers", "Elenca provider configurati"],
        ["stats", "Statistiche token e costi"],
        ["version", "Versione opencode"],
        ["sessions", "Sessioni recenti"],
        ["continue", "Continua ultima sessione"],
        ["run", "Esegui un task di coding"],
        ["export", "Esporta sessione come JSON"],
        ["agent", "Seleziona agente"],
        ["config", "Mostra configurazione"],
        ["project", "Cambia progetto attivo"],
        ["projects", "Lista progetti"],
        ["shell", "Esegui comando shell raw"],
    ];
    const r = await tg("setMyCommands", {
        commands: cmds.map(([c, d]) => ({ command: c, description: d })),
    });
    if (r.ok)
        console.log("📋 Comandi Telegram registrati (" + cmds.length + ")");
    else console.error("❌ Errore registrazione comandi:", r.description);
})();

poll();
