import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from './utils.mjs';

const MAX_TIMELINE = 200;

export class TelemetryStore {
  constructor(collector, wsServer = null) {
    this.collector = collector;
    this.ws = wsServer;
    this._timeline = []; // Recent events for new WS clients
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

  _ingestOfflineLogs() {
    const offlineLogPath = join(process.cwd(), '.hydra', 'usage_logs.jsonl');
    try {
      if (existsSync(offlineLogPath)) {
        const content = readFileSync(offlineLogPath, 'utf8');
        const lines = content.trim().split('\n');
        const events = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line));
          } catch (_) {
            // Ignore malformed JSON lines from offline file
          }
        }
        if (events.length > 0) {
          console.log(`[TelemetryStore] Ingesting ${events.length} offline fallback logs...`);
          this.ingest(events);
        }
        try {
          unlinkSync(offlineLogPath);
        } catch (_) {
          // Ignore error deleting fallback file
        }
      }
    } catch (e) {
      console.warn('[TelemetryStore] Failed to ingest offline logs:', e.message);
    }
  }

  _loadInitialLiveState() {
    const searchPaths = [
      join(process.cwd(), '.hydra', 'loop-state.json'),
      join(process.cwd(), '..', 'loop', '.hydra', 'loop-state.json'),
    ];
    for (const statePath of searchPaths) {
      try {
        if (existsSync(statePath)) {
          const data = JSON.parse(readFileSync(statePath, 'utf8'));
          this._updateLiveStateFromStatus(data);
          return;
        }
      } catch (e) {
        // @expected-error: JSON parsing error for stored log
      }
    }
  }

  _updateLiveStateFromStatus(s) {
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
    this._liveState.lastError = s.lastError || null;

    if (s.taskId || s.taskTitle || s.project) {
      this._liveState.currentTask = {
        id: s.taskId || this._liveState.currentTask?.id || null,
        title: s.taskTitle || this._liveState.currentTask?.title || '—',
        projectSlug: s.project || this._liveState.currentTask?.projectSlug || '—',
      };
    }
  }

  /**
   * Ingest one or more telemetry events.
   * @param {Object|Object[]} events
   */
  ingest(events) {
    const batch = Array.isArray(events) ? events : [events];
    for (const raw of batch) {
      const event = this._normalize(raw);
      if (!event) continue;

      // 1. Persist
      this.collector.insertEvent(event);

      // 2. Update live state
      this._updateLiveState(event);

      // 3. Add to timeline
      this._timeline.push(event);
      if (this._timeline.length > MAX_TIMELINE) this._timeline.shift();

      // 4. Broadcast to WebSocket clients
      if (this.ws) {
        this.ws.broadcast({ type: 'event', event });
      }
    }
  }

  _normalize(raw) {
    if (!raw || !raw.source || !raw.message) return null;
    return {
      id: raw.id || uuidv7(),
      ts: raw.ts || new Date().toISOString(),
      type: raw.type || 'log',
      level: raw.level || 'info',
      source: raw.source,
      message: raw.message,
      data: raw.data || null,
      sessionId: raw.sessionId || null,
      taskId: raw.taskId || null,
      projectId: raw.projectId || null,
    };
  }

  _updateLiveState(event) {
    this._liveState.lastEventTs = event.ts;

    switch (event.type) {
      case 'loop.status':
        if (event.data) {
          this._updateLiveStateFromStatus(event.data);
        }
        break;
      case 'phase.transition':
        this._liveState.phase = event.data?.to || 'IDLE';
        if (this._liveState.phase !== 'WAIT_HUMAN') {
          this._liveState.hitl = null;
        }
        break;
      case 'task.selected':
        this._liveState.currentTask = {
          id: event.taskId,
          title: event.data?.title,
          projectSlug: event.data?.projectSlug,
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
          type: event.data?.agentType,
          sessionId: event.sessionId,
          startedAt: event.ts,
        };
        break;
      case 'agent.completed':
      case 'agent.error':
        this._liveState.activeAgent = null;
        break;
      case 'model.call': {
        const callData = event.data || {};
        this.collector.logCall(callData);
        const innerData = callData.data || {};
        const usage = innerData.promptCache?.lastCallUsage || {};

        const tokens =
          usage.totalTokens ||
          (usage.input !== undefined && usage.output !== undefined
            ? usage.input + usage.output
            : 0) ||
          callData.tokens ||
          callData.total_tokens ||
          0;

        const cost =
          (typeof usage.cost?.total === 'number' ? usage.cost.total : 0) ||
          (typeof callData.cost === 'number' ? callData.cost : 0) ||
          0;

        this._liveState.tokensToday += tokens;
        this._liveState.costToday += cost;
        break;
      }
      case 'process.status':
        if (event.data) {
          if (event.data.name) {
            // Single service exit/status change
            const status = event.data.status;
            this._liveState.processes[event.data.name] = {
              running: status === 'running',
              pid: event.data.pid || null,
            };
          } else {
            // Multi-service health ping
            for (const [name, service] of Object.entries(event.data)) {
              if (name === 'bridge') {
                this._liveState.uptimeSec = service.uptime || 0;
                this._liveState.lastHealthPingTs = Date.now();
              } else {
                this._liveState.processes[name] = {
                  running: !!service.running,
                  pid: service.pid || null,
                  phase: service.phase || null,
                  restartDelay: service.restartDelay || null,
                };
              }
            }
          }
        }
        break;
      case 'hitl.requested':
        this._liveState.hitl = {
          gateType: event.data?.gateType || 'approval',
          requestId: event.data?.requestId || 'none',
          details: event.data?.details || {},
          ts: event.ts,
          active: true,
        };
        break;
      case 'hitl.resolved':
        this._liveState.hitl = null;
        break;
    }
  }

  getSnapshot() {
    return {
      liveState: { ...this._liveState },
      timeline: this._timeline.slice(-50),
    };
  }

  getTimeline(limit = 50) {
    return this._timeline.slice(-limit);
  }
}
