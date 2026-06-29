import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from './utils.js';
import type { TelemetryEvent, TelemetryEventInput } from './telemetry-client.js';
import type { MetricsCollector, LogCallData } from './collector.js';
import type { DashboardWebSocket } from './websocket.js';

const MAX_TIMELINE = 200;

interface ProcessInfo {
  running: boolean;
  pid: number | null;
  phase?: string | null;
  restartDelay?: number | null;
}

interface TaskInfo {
  id: string | null;
  title: string;
  projectSlug: string;
}

interface AgentInfo {
  type: string;
  sessionId: string;
  startedAt: string;
}

interface HitlInfo {
  gateType: string;
  requestId: string;
  details: Record<string, unknown>;
  ts: string;
  active: boolean;
}

export interface LiveState {
  phase: string;
  currentTask: TaskInfo | null;
  activeAgent: AgentInfo | null;
  processes: Record<string, ProcessInfo>;
  costToday: number;
  tokensToday: number;
  tasksCompleted: number;
  tasksBlocked: number;
  tasksTotal: number;
  files: string[];
  uptimeSec: number;
  lastError: string | null;
  lastEventTs: string | null;
  lastHealthPingTs: number | null;
  hitl: HitlInfo | null;
}

interface LoopStatusEventData {
  phase?: string;
  cost?: number;
  tokens?: number;
  tasksCompleted?: number;
  tasksBlocked?: number;
  tasksTotal?: number;
  files?: string[];
  uptimeSec?: number;
  lastError?: string | null;
  taskId?: string;
  taskTitle?: string;
  project?: string;
}

interface ProcessStatusData {
  name?: string;
  status?: string;
  pid?: number | null;
  running?: boolean;
  phase?: string | null;
  restartDelay?: number | null;
  uptime?: number;
}

interface ServiceStatus {
  running?: boolean;
  pid?: number | null;
  phase?: string | null;
  restartDelay?: number | null;
  uptime?: number;
}

export class TelemetryStore {
  collector: MetricsCollector;
  ws: DashboardWebSocket | null;
  _timeline: TelemetryEvent[];
  _liveState: LiveState;

  constructor(collector: MetricsCollector, wsServer: DashboardWebSocket | null = null) {
    this.collector = collector;
    this.ws = wsServer;
    this._timeline = [];
    this._liveState = {
      phase: 'IDLE',
      currentTask: null,
      activeAgent: null,
      processes: {
        litellm: { running: false, pid: null },
        opencode: { running: false, pid: null },
        loop: { running: false, pid: null },
      },
      costToday: 0,
      tokensToday: 0,
      tasksCompleted: 0,
      tasksBlocked: 0,
      tasksTotal: 0,
      files: [],
      uptimeSec: 0,
      lastError: null,
      lastEventTs: null,
      lastHealthPingTs: null,
      hitl: null,
    };
    this._loadInitialLiveState();
    this._ingestOfflineLogs();
  }

  _ingestOfflineLogs(): void {
    const offlineLogPath = join(process.cwd(), '.hydra', 'usage_logs.jsonl');
    try {
      if (existsSync(offlineLogPath)) {
        const content = readFileSync(offlineLogPath, 'utf8');
        const lines = content.trim().split('\n');
        const events: TelemetryEventInput[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line) as TelemetryEventInput);
          } catch {
            // Ignore parse errors
          }
        }
        if (events.length > 0) {
          console.log(`[TelemetryStore] Ingesting ${events.length} offline fallback logs...`);
          this.ingest(events);
        }
        try {
          unlinkSync(offlineLogPath);
        } catch {
          // Ignore unlink errors
        }
      }
    } catch (e: unknown) {
      console.warn(
        '[TelemetryStore] Failed to ingest offline logs:',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  _loadInitialLiveState(): void {
    const searchPaths = [
      join(process.cwd(), '.hydra', 'loop-state.json'),
      join(process.cwd(), '..', 'loop', '.hydra', 'loop-state.json'),
    ];
    for (const statePath of searchPaths) {
      try {
        if (existsSync(statePath)) {
          const data = JSON.parse(readFileSync(statePath, 'utf8')) as LoopStatusEventData;
          this._updateLiveStateFromStatus(data);
          return;
        }
      } catch {
        // Ignore JSON parsing errors
      }
    }
  }

  _updateLiveStateFromStatus(s: LoopStatusEventData): void {
    if (!s) return;
    this._liveState.phase = s.phase || this._liveState.phase;
    this._liveState.costToday = s.cost !== undefined ? s.cost : this._liveState.costToday;
    this._liveState.tokensToday = s.tokens !== undefined ? s.tokens : this._liveState.tokensToday;
    this._liveState.tasksCompleted =
      s.tasksCompleted !== undefined ? s.tasksCompleted : this._liveState.tasksCompleted;
    this._liveState.tasksBlocked =
      s.tasksBlocked !== undefined ? s.tasksBlocked : this._liveState.tasksBlocked;
    this._liveState.tasksTotal =
      s.tasksTotal !== undefined ? s.tasksTotal : this._liveState.tasksTotal;
    this._liveState.files = s.files || [];
    this._liveState.uptimeSec = s.uptimeSec || 0;
    this._liveState.lastError = s.lastError ?? null;

    if (s.taskId || s.taskTitle || s.project) {
      this._liveState.currentTask = {
        id: s.taskId || this._liveState.currentTask?.id || null,
        title: s.taskTitle || this._liveState.currentTask?.title || '—',
        projectSlug: s.project || this._liveState.currentTask?.projectSlug || '—',
      };
    }
  }

  ingest(events: TelemetryEventInput | TelemetryEventInput[]): void {
    const batch = Array.isArray(events) ? events : [events];
    for (const raw of batch) {
      const event = this._normalize(raw);
      if (!event) continue;

      this.collector.insertEvent(event);

      this._updateLiveState(event);

      this._timeline.push(event);
      if (this._timeline.length > MAX_TIMELINE) this._timeline.shift();

      if (this.ws) {
        this.ws.broadcast({ type: 'event', event: event as unknown as Record<string, unknown> });
      }
    }
  }

  _normalize(raw: TelemetryEventInput): TelemetryEvent | null {
    if (!raw || !raw.source || !raw.message) return null;
    return {
      id: raw.id ?? uuidv7(),
      ts: raw.ts ?? new Date().toISOString(),
      type: raw.type ?? 'log',
      level: raw.level ?? 'info',
      source: raw.source,
      message: raw.message,
      data: raw.data ?? null,
      sessionId: raw.sessionId ?? null,
      taskId: raw.taskId ?? null,
      projectId: raw.projectId ?? null,
    };
  }

  _updateLiveState(event: TelemetryEvent): void {
    this._liveState.lastEventTs = event.ts;

    switch (event.type) {
      case 'loop.status':
        if (event.data) {
          this._updateLiveStateFromStatus(event.data as unknown as LoopStatusEventData);
        }
        break;
      case 'phase.transition':
        this._liveState.phase = (event.data?.to as string) || 'IDLE';
        if (this._liveState.phase !== 'WAIT_HUMAN') {
          this._liveState.hitl = null;
        }
        break;
      case 'task.selected':
        this._liveState.currentTask = {
          id: event.taskId,
          title: (event.data?.title as string) || '',
          projectSlug: (event.data?.projectSlug as string) || '',
        };
        break;
      case 'task.completed':
        this._liveState.tasksCompleted++;
        this._liveState.currentTask = null;
        break;
      case 'task.blocked':
        this._liveState.tasksBlocked++;
        break;
      case 'agent.started':
        this._liveState.activeAgent = {
          type: (event.data?.agentType as string) || '',
          sessionId: event.sessionId || '',
          startedAt: event.ts,
        };
        break;
      case 'agent.completed':
      case 'agent.error':
        this._liveState.activeAgent = null;
        break;
      case 'model.call': {
        const callData = (event.data || {}) as Record<string, unknown>;
        this.collector.logCall(callData as unknown as LogCallData);
        const innerData = (callData.data || {}) as Record<string, unknown>;
        const usage =
          ((innerData.promptCache as Record<string, unknown>)?.lastCallUsage as Record<
            string,
            unknown
          >) || {};

        const tokens =
          (usage.totalTokens as number) ||
          (usage.input !== undefined && usage.output !== undefined
            ? (usage.input as number) + (usage.output as number)
            : 0) ||
          (callData.tokens as number) ||
          (callData.total_tokens as number) ||
          0;

        const cost =
          (typeof (usage.cost as Record<string, unknown>)?.total === 'number'
            ? ((usage.cost as Record<string, unknown>).total as number)
            : 0) ||
          (typeof callData.cost === 'number' ? (callData.cost as number) : 0) ||
          0;

        this._liveState.tokensToday += tokens;
        this._liveState.costToday += cost;
        break;
      }
      case 'process.status': {
        const processData = event.data as Record<string, unknown> | null;
        if (processData) {
          if (processData.name) {
            const d = processData as unknown as ProcessStatusData;
            this._liveState.processes[d.name!] = {
              running: d.status === 'running',
              pid: d.pid || null,
            };
          } else {
            for (const [name, service] of Object.entries(processData)) {
              const svc = service as ServiceStatus;
              if (name === 'bridge') {
                this._liveState.uptimeSec = svc.uptime || 0;
                this._liveState.lastHealthPingTs = Date.now();
              } else {
                this._liveState.processes[name] = {
                  running: !!svc.running,
                  pid: svc.pid || null,
                  phase: svc.phase || null,
                  restartDelay: svc.restartDelay || null,
                };
              }
            }
          }
        }
        break;
      }
      case 'hitl.requested': {
        const hitlData = event.data as Record<string, unknown> | null;
        this._liveState.hitl = {
          gateType: (hitlData?.gateType as string) || 'approval',
          requestId: (hitlData?.requestId as string) || 'none',
          details: (hitlData?.details as Record<string, unknown>) || {},
          ts: event.ts,
          active: true,
        };
        break;
      }
      case 'hitl.resolved':
        this._liveState.hitl = null;
        break;
    }
  }

  getSnapshot(): { liveState: LiveState; timeline: TelemetryEvent[] } {
    return {
      liveState: { ...this._liveState },
      timeline: this._timeline.slice(-50),
    };
  }

  getTimeline(limit = 50): TelemetryEvent[] {
    return this._timeline.slice(-limit);
  }
}
