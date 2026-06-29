import { TaskManager } from '../../src/core/task-manager.js';
import { TelegramChannel } from '../../src/bot/telegram-channel.js';
import { MemoryManager } from '../../src/core/memory-manager.js';
import { Safety } from '../../src/core/safety.js';
import NotionAdapter from '../../src/core/notion-adapter.js';
import { EventStream } from '../../src/core/event-stream.js';
import { DurableStateManager } from '../../src/core/durable-state.js';

export interface OrchestratorContext {
  projectPath: string;
  state: DurableStateManager;
  notion: NotionAdapter;
  telegram: TelegramChannel;
  tasks: TaskManager;
  memory: MemoryManager;
  safety: Safety;
  stream: EventStream;
  log: (msg: string) => void;
  updateStatus: (delta: Record<string, unknown>) => void;
}

export type PhaseHandler = (ctx: OrchestratorContext) => Promise<void>;
