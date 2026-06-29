import { appendFile as appendFilePromise } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { EventStream, type StreamEvent } from './event-stream.js';

export interface MemoryPattern {
  _norm: string;
  text: string;
  directory: string;
  sourceStory: string;
  createdAt: string;
}

export interface ProgressEntry {
  phase?: string;
  taskId?: string;
  summary?: string;
  learnings?: string[];
  qa?: string;
  cost?: number;
}

interface CompactRuntime {
  task?: { title?: string; description?: string; [key: string]: unknown } | null;
  run(ms: number): Promise<{ ok: boolean; content?: string; result?: unknown; error?: string }>;
}

export class MemoryManager {
  readonly projectPath: string;
  readonly stream: EventStream | null;
  readonly hydraDir: string;
  readonly jsonlPath: string;
  readonly patternsPath: string;
  readonly progressPath: string;

  constructor(projectPath: string, stream: EventStream | null = null) {
    this.projectPath = projectPath;
    this.stream = stream;
    this.hydraDir = join(projectPath, '.hydra');
    if (!existsSync(this.hydraDir)) mkdirSync(this.hydraDir, { recursive: true });
    this.jsonlPath = join(this.hydraDir, 'event-stream.jsonl');
    this.patternsPath = join(this.hydraDir, 'patterns.json');
    this.progressPath = join(projectPath, 'progress.txt');
    this.ensureFiles();
  }

  private ensureFiles(): void {
    if (!existsSync(this.jsonlPath)) writeFileSync(this.jsonlPath, '', 'utf-8');
    if (!existsSync(this.patternsPath)) writeFileSync(this.patternsPath, '[]', 'utf-8');
    if (!existsSync(this.progressPath)) {
      writeFileSync(
        this.progressPath,
        '# Progress Log\n\n## Codebase Patterns\n(Add reusable patterns here)\n\n---\n\n## Chronological Log\n\n',
        'utf-8',
      );
    }
  }

  async appendEvent(type: string, payload?: Record<string, unknown>): Promise<void> {
    if (this.stream) {
      this.stream.emit(type, 'system', payload ?? {});
    } else {
      const line = JSON.stringify({ ts: Date.now(), type, payload });
      try {
        await appendFilePromise(this.jsonlPath, line + '\n');
      } catch {
        console.error('[MemoryManager] Failed to append event');
      }
    }
  }

  readEvents(since: number = 0): StreamEvent[] {
    try {
      return readFileSync(this.jsonlPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => {
          const ts = e.ts ?? (e.timestamp ? new Date(e.timestamp).getTime() : 0);
          return ts >= since;
        });
    } catch {
      return [];
    }
  }

  readRecentEvents(n: number = 10): StreamEvent[] {
    try {
      const lines = readFileSync(this.jsonlPath, 'utf-8').split('\n').filter(Boolean);
      return lines
        .slice(-n)
        .map((l) => {
          try {
            return JSON.parse(l) as StreamEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is StreamEvent => e !== null);
    } catch {
      return [];
    }
  }

  loadPatterns(): MemoryPattern[] {
    try {
      return JSON.parse(readFileSync(this.patternsPath, 'utf-8')) as MemoryPattern[];
    } catch {
      return [];
    }
  }

  private savePatterns(list: MemoryPattern[]): void {
    writeFileSync(this.patternsPath, JSON.stringify(list, null, 2));
  }

  addPattern(text: string, meta?: { directory?: string; storyId?: string }): boolean {
    const patterns = this.loadPatterns();
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (patterns.some((p) => p._norm === norm)) return false;
    patterns.unshift({
      _norm: norm,
      text,
      directory: meta?.directory ?? '',
      sourceStory: meta?.storyId ?? '',
      createdAt: new Date().toISOString(),
    });
    while (patterns.length > 200) patterns.pop();
    this.savePatterns(patterns);
    return true;
  }

  getPatternsSnippet(): string {
    return this.loadPatterns()
      .slice(0, 30)
      .map((p) => `- ${p.text}`)
      .join('\n');
  }

  appendProgress(entry: ProgressEntry): void {
    const header = `## ${new Date().toISOString()} — ${entry.phase || 'entry'}\n`;
    const parts: string[] = [];
    if (entry.taskId) parts.push(`- Task: ${entry.taskId}`);
    if (entry.summary) parts.push(`- Summary: ${entry.summary}`);
    if (entry.learnings?.length) {
      parts.push(`- Learnings:\n${entry.learnings.map((l) => `  - ${l}`).join('\n')}`);
    }
    if (entry.qa) parts.push(`- QA: ${entry.qa}`);
    if (entry.cost !== undefined) parts.push(`- Cost: $${entry.cost.toFixed(2)}`);

    const block = `${header}${parts.join('\n')}\n---\n`;
    try {
      const current = readFileSync(this.progressPath, 'utf-8');
      writeFileSync(this.progressPath, current + block, 'utf-8');
    } catch {
      console.error('[MemoryManager] Failed to append progress');
    }
    this.appendEvent('progressAppended', {
      taskId: entry.taskId ?? '',
      summary: entry.summary ?? '',
    });
  }

  needsCompaction(): boolean {
    try {
      const st = statSync(this.jsonlPath);
      return st.size > 50 * 1024 * 1024;
    } catch {
      return false;
    }
  }

  async compact(summarizerCallback?: () => CompactRuntime | undefined): Promise<boolean> {
    let summaryText = '';
    if (typeof summarizerCallback === 'function') {
      try {
        const runtime = summarizerCallback();
        if (runtime) {
          const events = this.readRecentEvents(100);
          runtime.task = {
            title: 'Summarize event stream log',
            description: JSON.stringify(events, null, 2),
          };
          const res = await runtime.run(180000);
          if (res.ok) {
            const resultInfo = res.result as { info?: { content?: string } } | undefined;
            summaryText = res.content ?? resultInfo?.info?.content ?? '';
          }
        }
      } catch {
        console.error('[MemoryManager] Semantic compaction summarization failed');
      }
    }

    try {
      if (!existsSync(this.jsonlPath)) return true;
      for (let i = 2; i >= 0; i--) {
        const src = i === 0 ? this.jsonlPath : `${this.jsonlPath}.${i}`;
        const dst = `${this.jsonlPath}.${i + 1}`;
        if (existsSync(src)) {
          renameSync(src, dst);
        }
      }
      writeFileSync(this.jsonlPath, '', 'utf-8');
      await this.appendEvent('compactionDone', { sizeMb: 50, keptBackups: 3 });
      if (summaryText) {
        await this.appendEvent('compactionSummary', { summary: summaryText });
      }
      return true;
    } catch {
      await this.appendEvent('compactionFailed', {});
      return false;
    }
  }
}

export default MemoryManager;
