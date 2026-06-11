#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mod = (p) => join(__dirname, "../..", p);

import { getDurableState } from "../../src/core/durable-state.mjs";
import { TaskManager } from "../../src/core/task-manager.mjs";
import { TelegramChannel } from "../../src/bot/telegram-channel.mjs";
import { MemoryManager } from "../../src/core/memory-manager.mjs";
import { Safety } from "../../src/core/safety.mjs";
import NotionAdapter from "../../src/core/notion-adapter.mjs";
import { EventStream } from "../../src/core/event-stream.mjs";

async function main() {
  const args = process.argv.slice(2);
  const projectPath = args[0];
  if (!projectPath) {
    console.error("Usage: node agents/orchestrator/index.mjs <project-path>");
    process.exit(1);
  }



  const state = getDurableState(projectPath);
  const checkpoint = state.load();

  const notion = new NotionAdapter({
    token: process.env.NOTION_API_TOKEN,
    databaseId: process.env.NOTION_DATABASE_ID,
    pageId: process.env.NOTION_PAGE_ID,
  });
  
  const telegram = new TelegramChannel({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.HYDRA_CHAT_ID || null,
  });
  
  const tasks = new TaskManager({ projectPath, notionAdapter: notion });
  const stream = new EventStream(projectPath);
  const memory = new MemoryManager(projectPath, stream);
  const safety = new Safety(projectPath);

  await telegram.initPinned();

  const context = {
    projectPath,
    state,
    notion,
    telegram,
    tasks,
    memory,
    safety,
    stream,
    log: (msg) => {
      const time = new Date().toISOString().slice(11, 19);
      console.log(`[${time}] ${msg}`);
      memory.appendEvent("log", { message: msg });
    },
    updateStatus: (delta) => {
      telegram.updateStatus(delta);
      try {
        const statePath = join(projectPath, ".hydra", "loop-state.json");
        writeFileSync(statePath, JSON.stringify(telegram._status, null, 2));
      } catch {}
    }
  };

  // Load phase handlers
  const { handleIdle } = await import("./phases/idle.mjs");
  const { handlePlan } = await import("./phases/plan.mjs");
  const { handleExec } = await import("./phases/exec.mjs");
  const { handleQa } = await import("./phases/qa.mjs");
  const { handleFix } = await import("./phases/fix.mjs");
  const { handleSwarm } = await import("./phases/swarm.mjs");
  const { handleVisualQa } = await import("./phases/visual-qa.mjs");
  const { handleCommit } = await import("./phases/commit.mjs");
  const { handleReflect } = await import("./phases/reflect.mjs");
  const { handleDiscover } = await import("./phases/discover.mjs");
  const { handleSync } = await import("./phases/sync.mjs");
  const { handleWaitHuman } = await import("./phases/wait-human.mjs");
 
  // Event Driven state machine
  stream.on("System", async (event) => {
    if (event.payload?.action === "PhaseChange") {
      const nextPhase = event.payload.phase;
      context.log(`[EventStream] Transitioning to phase: ${nextPhase}`);
      state.transition(nextPhase, event.payload.stateUpdates);
      
      try {
        switch (nextPhase) {
          case "IDLE": await handleIdle(context); break;
          case "PLAN": await handlePlan(context); break;
          case "EXEC": await handleExec(context); break;
          case "QA": await handleQa(context); break;
          case "VISUAL_QA": await handleVisualQa(context); break;
          case "FIX": await handleFix(context); break;
          case "SWARM": await handleSwarm(context); break;
          case "COMMIT": await handleCommit(context); break;
          case "REFLECT": await handleReflect(context); break;
          case "SYNC": await handleSync(context); break;
          case "DISCOVER": await handleDiscover(context); break;
          case "WAIT_HUMAN":
            await handleWaitHuman(context);
            break;
          default:
            context.log(`Unknown phase: ${nextPhase}`);
        }
      } catch (e) {
        context.log(`Error in phase ${nextPhase}: ${e.message}`);
      }
    }
  });

  context.log(`🔥 Orchestrator starting — ${projectPath}`);
  context.log(`Checkpoint phase: ${checkpoint.phase || "IDLE"}`);

  // Kickstart
  stream.emit("System", "system", { action: "PhaseChange", phase: checkpoint.phase || "IDLE" });

  // IPC Command Intercept
  if (process.send) {
    process.on('message', (msg) => {
      if (msg.action === 'dashboard_cmd') {
        if (msg.cmd === "pause") {
          context.log("⏸️ Loop paused by Web Dashboard (IPC)");
          stream.emit("System", "system", { action: "PhaseChange", phase: "WAIT_HUMAN", stateUpdates: { reason: "Paused by dashboard" } });
        } else if (msg.cmd === "resume") {
          context.log("▶️ Loop resumed by Web Dashboard (IPC)");
          stream.emit("System", "system", { action: "PhaseChange", phase: "IDLE" });
        }
      }
    });
  }
}

main().catch(console.error);
