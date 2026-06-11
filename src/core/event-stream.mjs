import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * EventStream — Append-only immutable event log (OpenHands architecture).
 * Acts as the backbone for agent-environment-UI communication.
 */
export class EventStream {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.streamDir = join(projectPath, ".hydra");
    if (!existsSync(this.streamDir)) {
      mkdirSync(this.streamDir, { recursive: true });
    }
    this.logFile = join(this.streamDir, "event-stream.jsonl");
    this.bus = new EventEmitter();
    this.idCounter = this._initCounter();
  }

  _initCounter() {
    try {
      if (existsSync(this.logFile)) {
        const content = readFileSync(this.logFile, "utf-8").trim();
        if (content) {
          const lines = content.split("\n");
          const lastLine = lines[lines.length - 1];
          const parsed = JSON.parse(lastLine);
          return (parsed.id || 0) + 1;
        }
      }
    } catch {}
    return 1;
  }

  /**
   * Append a new event to the stream and broadcast it.
   * @param {string} type - "Action", "Observation", "Thought", "System"
   * @param {string} source - "agent", "environment", "user", "system"
   * @param {Object} payload - Event specific data
   */
  emit(type, source, payload) {
    const event = {
      id: this.idCounter++,
      timestamp: new Date().toISOString(),
      type,
      source,
      payload
    };

    const line = JSON.stringify(event) + "\n";
    try {
      appendFileSync(this.logFile, line, "utf-8");
    } catch (e) {
      console.error("[EventStream] Failed to write event:", e.message);
    }

    // Broadcast to listeners
    this.bus.emit(type, event);
    this.bus.emit("all", event);
  }

  on(type, listener) {
    this.bus.on(type, listener);
  }

  off(type, listener) {
    this.bus.off(type, listener);
  }
}
