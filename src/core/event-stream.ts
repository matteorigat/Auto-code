import { EventEmitter } from 'node:events';
import { appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StreamEvent {
  id: number;
  timestamp: string;
  type: string;
  source: string;
  payload: unknown;
}

export class EventStream {
  readonly projectPath: string;
  readonly streamDir: string;
  readonly logFile: string;
  readonly bus: EventEmitter;
  idCounter: number;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.streamDir = join(projectPath, '.hydra');
    if (!existsSync(this.streamDir)) {
      mkdirSync(this.streamDir, { recursive: true });
    }
    this.logFile = join(this.streamDir, 'event-stream.jsonl');
    this.bus = new EventEmitter();
    this.idCounter = this.initCounter();
  }

  private initCounter(): number {
    try {
      if (existsSync(this.logFile)) {
        const content = readFileSync(this.logFile, 'utf-8').trim();
        if (content) {
          const lines = content.split('\n');
          const lastLine = lines[lines.length - 1];
          if (lastLine) {
            const parsed = JSON.parse(lastLine);
            return (parsed.id || 0) + 1;
          }
        }
      }
    } catch {
      return 1;
    }
    return 1;
  }

  async emit(type: string, source: string, payload: unknown): Promise<StreamEvent> {
    const event: StreamEvent = {
      id: this.idCounter++,
      timestamp: new Date().toISOString(),
      type,
      source,
      payload,
    };

    const line = JSON.stringify(event) + '\n';
    try {
      await appendFile(this.logFile, line, 'utf-8');
    } catch {
      console.error('[EventStream] Failed to write event');
    }

    this.bus.emit(type, event);
    this.bus.emit('all', event);
    return event;
  }

  on(type: string, listener: (event: StreamEvent) => void): this {
    this.bus.on(type, listener);
    return this;
  }

  off(type: string, listener: (event: StreamEvent) => void): this {
    this.bus.off(type, listener);
    return this;
  }

  removeAllListeners(type?: string): this {
    this.bus.removeAllListeners(type);
    return this;
  }
}
