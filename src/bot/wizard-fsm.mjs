import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { PROJECTS } from "../core/projects.mjs";

const WIZARD_ACTIONS = {
    "1": "loop", "loop": "loop",
    "2": "chat", "chat": "chat",
    "3": "create", "create": "create",
};

export class WizardFSM {
    constructor(bot, loopManager, chatSessionManager) {
        this.bot = bot;
        this.loopManager = loopManager; // { startLoop(chatId, projectKey) }
        this.chatSessionManager = chatSessionManager; // { createChatSession(chatId, projectKey) }
    }

    startWizard(st, action = null) {
        st.wizard = { step: "action", action, newName: null, newPath: null, newDesc: null };
    }

    async handleWizard(chatId, text, st) {
        const w = st.wizard;
        if (!w) return;

        // Cancel any time
        if (text.toLowerCase() === "cancel" || text === "/cancel" || text === "❌") {
            st.wizard = null;
            return this.bot.send(chatId, "❌ Wizard annullato.");
        }

        // Back any time
        if (text.toLowerCase() === "back" || text === "🔙") {
            return this._wizardBack(chatId, st);
        }

        switch (w.step) {
            case "action": {
                const action = WIZARD_ACTIONS[text.toLowerCase()];
                if (!action) {
                    return this.bot.send(chatId, "❌ Non ho capito. Rispondi con 1 (loop), 2 (chat) o 3 (create).");
                }
                w.action = action;
                if (action === "loop") {
                    st.wizard = null;
                    await this.bot.send(chatId, "🔄 Avvio Hydra Loop globale (basato su Notion)...");
                    return this.loopManager.startLoop(chatId);
                }
                w.step = "project";
                if (action === "create") {
                    return this.bot.send(chatId, "📝 *Nome progetto:* (es. `my-app`)\\n\\nPoi potrai avviare loop o chat su di esso.\\n`back` per tornare.");
                }
                return this._wizardPickProject(chatId, st);
            }

            case "project": {
                if (text.toLowerCase() === "new") {
                    w.step = "new_name";
                    return this.bot.send(chatId, "📝 *Nome progetto:* (es. `my-app`)\\n\\nScrivi `back` per tornare indietro.");
                }
                const choice = text.trim();
                const keys = Object.keys(PROJECTS);
                const idx = parseInt(choice, 10) - 1;
                const key = keys[idx] || choice;
                if (!PROJECTS[key]) {
                    return this.bot.send(chatId, `❌ Progetto sconosciuto. Scrivi il numero o il nome.\\n\\nScrivi \`new\` per crearne uno nuovo.`);
                }
                st.project = key;
                st.wizard = null;
                await this.bot.send(chatId, `💬 Apro sessione chat su \`${key}\` — ${PROJECTS[key].desc}...`);
                return this.chatSessionManager.createChatSession(chatId, key, st);
            }

            case "new_name": {
                if (!/^[a-zA-Z0-9_-]{1,40}$/.test(text.trim())) {
                    return this.bot.send(chatId, "❌ Nome non valido. Usa lettere, numeri, `-` o `_` (max 40 caratteri).");
                }
                w.newName = text.trim();
                w.step = "new_path";
                const home = homedir();
                return this.bot.send(chatId, `📁 *Percorso:* (es. \`${join(home, "projects", w.newName)}\`)\\n\\nLascia vuoto per usare il default, \`back\` per tornare.`);
            }

            case "new_path": {
                const p = text.trim();
                w.newPath = p || join(homedir(), "projects", w.newName);
                w.step = "new_desc";
                return this.bot.send(chatId, "📄 *Descrizione:* (opzionale, scrivi `skip` per saltare)\\n\\nEs. \"Next.js blog app\"");
            }

            case "new_desc": {
                w.newDesc = text.toLowerCase() === "skip" ? "" : text.trim();
                w.step = "confirm";
                return this.bot.send(chatId,
                    `📋 *Conferma creazione progetto*\\n\\n` +
                    `Nome: \`${w.newName}\`\\n` +
                    `Percorso: \`${w.newPath}\`\\n` +
                    `Descrizione: ${w.newDesc || "—"}\\n\\n` +
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
                    await this.bot.send(chatId, `✅ Progetto \`${key}\` creato in \`${w.newPath}\``);
                    if (w.action === "create") {
                        await this.bot.send(chatId,
                            `Cosa vuoi fare su \`${key}\`?\\n\\n` +
                            `1️⃣ Avviare Hydra Loop\\n` +
                            `2️⃣ Aprire sessione chat\\n` +
                            `\`cancel\` per terminare.`
                        );
                        w.action = null; 
                        w.step = "post_create";
                        w.newName = key; 
                        return;
                    }
                    if (w.action === "loop") {
                        st.wizard = null;
                        await this.bot.send(chatId, `🔄 Avvio Hydra Loop su \`${key}\`...`);
                        return this.loopManager.startLoop(chatId, key);
                    }
                    if (w.action === "chat") {
                        st.wizard = null;
                        return this.chatSessionManager.createChatSession(chatId, key, st);
                    }
                    st.wizard = null;
                    return this.bot.send(chatId, "✅ Fatto. Scrivi /new per iniziare.");
                }
                this.startWizard(st, w.action);
                return this.bot.send(chatId, "❌ Annullato. Ricominciamo.\\n\\n1️⃣ Loop\\n2️⃣ Chat\\n3️⃣ Crea progetto");
            }

            case "post_create": {
                const act = WIZARD_ACTIONS[text.toLowerCase()];
                const key = w.newName;
                if (!act || act === "create" || !key || !PROJECTS[key]) {
                    return this.bot.send(chatId, "❌ Scegli 1 (loop) o 2 (chat).");
                }
                if (act === "loop") {
                    st.wizard = null;
                    return this.loopManager.startLoop(chatId, key);
                }
                if (act === "chat") {
                    st.wizard = null;
                    return this.chatSessionManager.createChatSession(chatId, key, st);
                }
                st.wizard = null;
                return this.bot.send(chatId, "✅ Fatto.");
            }

            default:
                st.wizard = null;
                return this.bot.send(chatId, "❌ Wizard corrotto. Usa /new per ricominciare.");
        }
    }

    async _wizardBack(chatId, st) {
        const w = st.wizard;
        const prev = { new_name: "action", new_path: "new_name", new_desc: "new_path", confirm: "new_desc", project: "action", post_create: "action" };
        const p = prev[w.step];
        if (p) {
            w.step = p;
            if (p === "action") return this.bot.send(chatId, "1️⃣ Loop\\n2️⃣ Chat\\n3️⃣ Crea progetto");
            if (p === "new_name") return this.bot.send(chatId, "📝 *Nome progetto:*");
            if (p === "new_path") {
                const home = homedir();
                return this.bot.send(chatId, `📁 *Percorso:* (default: \`${join(home, "projects", w.newName)}\`)`);
            }
            if (p === "new_desc") return this.bot.send(chatId, "📄 *Descrizione:* (\`skip\` per saltare)");
            if (p === "project") return this._wizardPickProject(chatId, st);
        }
        this.startWizard(st);
        return this.bot.send(chatId, "1️⃣ Loop\\n2️⃣ Chat\\n3️⃣ Crea progetto");
    }

    async _wizardPickProject(chatId, st) {
        const keys = Object.keys(PROJECTS);
        const list = keys.map((k, i) => `  ${i + 1}. \`${k}\` — ${PROJECTS[k].desc}`).join("\\n");
        await this.bot.send(chatId,
            `📁 *Scegli progetto per la chat:*\\n\\n${list}\\n\\nScrivi il numero o il nome.\\n\`new\` per crearne uno, \`back\` per tornare.`
        );
    }
}
