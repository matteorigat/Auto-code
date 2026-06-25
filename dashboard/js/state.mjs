export class AppState {
  constructor() {
    this.events = [];
    this._eventIds = new Set();
    this.logs = [];
    this.systemMetrics = {
      cpu: 0,
      cpu_pct: 0,
      ramUsed: 0,
      ramTotal: 0,
      ramPct: 0,
      ram_pct: 0,
      diskUsed: 0,
      diskTotal: 0,
      diskPct: 0,
      disk_pct: 0,
    };
    this.bridgeState = {
      opencode: { running: false },
      litellm: { running: false },
      loop: { running: false, phase: 'IDLE' },
    };
    this.calls = [];
    this.sessions = [];
    this.quota = null;
    this.routingChain = [];
    this.sotaStats = null;
    this.summary = {};
    this.dailyData = [];
    this.hitl = null;
    this.activeTab = 'overview';
    this.timeRange = '1d';
    this.listeners = new Set();
    this._notifyScheduled = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    if (this._notifyScheduled) return;
    this._notifyScheduled = true;
    queueMicrotask(() => {
      this._notifyScheduled = false;
      for (const listener of this.listeners) {
        try {
          listener(this);
        } catch (err) {
          console.error('Listener error', err);
        }
      }
    });
  }

  clearLogs() {
    this.logs = [];
    this.notify();
  }

  loadSnapshot(snap) {
    if (!snap) return;

    if (snap.liveState) {
      const ls = snap.liveState;
      this.bridgeState.loop = {
        running: ls.phase !== 'IDLE',
        phase: ls.phase || 'IDLE',
        cost: ls.costToday || 0,
        tokens: ls.tokensToday || 0,
        tasksCompleted: ls.tasksCompleted || 0,
        tasksBlocked: ls.tasksBlocked || 0,
        tasksTotal: ls.tasksTotal || 0,
        project: ls.currentTask?.projectSlug || '—',
        taskTitle: ls.currentTask?.title || '—',
        taskId: ls.currentTask?.id || null,
        files: ls.files || [],
        uptimeSec: ls.uptimeSec || 0,
        lastError: ls.lastError || null,
      };

      if (ls.processes) {
        for (const [name, proc] of Object.entries(ls.processes)) {
          this.bridgeState[name] = proc;
        }
      }

      this.hitl = ls.hitl || null;
    }

    if (snap.timeline && Array.isArray(snap.timeline)) {
      const eventsCopy = [...snap.timeline].sort((a, b) => new Date(a.ts) - new Date(b.ts));
      eventsCopy.forEach((ev) => this.addEvent(ev, false));
    }

    this.notify();
  }

  addEvent(ev, triggerNotify = true) {
    if (!ev || !ev.type) return;

    if (ev.id) {
      if (this._eventIds.has(ev.id)) return;
      this._eventIds.add(ev.id);
    }

    this.events.unshift(ev);
    if (this.events.length > 2000) {
      const removed = this.events.pop();
      if (removed?.id) this._eventIds.delete(removed.id);
    }

    if (ev.type === 'log') {
      this.logs.unshift(ev);
      if (this.logs.length > 1000) this.logs.pop();
    } else if (ev.type === 'system.metrics') {
      if (ev.data && (ev.data.cpu !== undefined || ev.data.cpu_pct !== undefined)) {
        this.systemMetrics = ev.data;
      }
    } else if (ev.type === 'process.status') {
      if (ev.data) {
        if (ev.data.name) {
          this.bridgeState[ev.data.name] = ev.data;
        } else {
          for (const [name, service] of Object.entries(ev.data)) {
            if (name !== 'bridge') {
              this.bridgeState[name] = service;
            }
          }
        }
      }
    } else if (ev.type === 'model.completed' || ev.type === 'model.call') {
      const usage = ev.data?.data?.promptCache?.lastCallUsage || {};
      const inp = usage.input || ev.data?.input_tokens || 0;
      const out = usage.output || ev.data?.output_tokens || 0;
      const tt = ev.data?.tokens || ev.data?.total_tokens || inp + out;
      const cost = usage.cost?.total || ev.data?.cost || 0;

      const callRecord = {
        ts: ev.ts,
        provider: ev.data?.provider || ev.source || 'litellm',
        model: ev.data?.modelId || ev.data?.model || ev.message || 'unknown',
        input_tokens: inp,
        output_tokens: out,
        total_tokens: tt,
        status: ev.data?.status || (ev.level === 'error' ? 'error' : 'ok'),
        prompt: ev.data?.prompt || '',
        response: ev.data?.response || '',
        data: ev.data || {},
      };

      this.calls.unshift(callRecord);
      if (this.calls.length > 500) this.calls.pop();

      this.summary.totalCalls = (this.summary.totalCalls || 0) + 1;
      this.summary.totalInput = (this.summary.totalInput || 0) + inp;
      this.summary.totalOutput = (this.summary.totalOutput || 0) + out;
      this.summary.totalCost = (this.summary.totalCost || 0) + cost;
      if (callRecord.status !== 'ok') {
        this.summary.totalErrors = (this.summary.totalErrors || 0) + 1;
      }

      const todayStr = new Date().toISOString().substring(0, 10);
      const callDateStr = new Date(callRecord.ts).toISOString().substring(0, 10);
      if (callDateStr === todayStr) {
        this.summary.todayCalls = (this.summary.todayCalls || 0) + 1;
        this.summary.todayCost = (this.summary.todayCost || 0) + cost;
      }

      this.summary.byModel ??= [];
      let modelEntry = this.summary.byModel.find((m) => m.model === callRecord.model);
      if (!modelEntry) {
        modelEntry = {
          provider: callRecord.provider,
          model: callRecord.model,
          total_calls: 0,
          total_cost: 0,
        };
        this.summary.byModel.push(modelEntry);
      }
      modelEntry.total_calls += 1;
      modelEntry.total_cost += cost;

      this.dailyData ??= [];
      let dailyEntry = this.dailyData.find(
        (d) => d.date === callDateStr && d.model === callRecord.model,
      );
      if (!dailyEntry) {
        dailyEntry = {
          date: callDateStr,
          provider: callRecord.provider,
          model: callRecord.model,
          cost: 0,
          calls: 0,
        };
        this.dailyData.push(dailyEntry);
      }
      dailyEntry.cost += cost;
      dailyEntry.calls += 1;
    } else if (ev.type === 'loop.status') {
      if (ev.data) {
        const s = ev.data;
        this.bridgeState.loop = {
          running: s.phase !== 'IDLE',
          phase: s.phase || 'IDLE',
          cost: s.cost || 0,
          tokens: s.tokens || 0,
          tasksCompleted: s.tasksCompleted || 0,
          tasksBlocked: s.tasksBlocked || 0,
          tasksTotal: s.tasksTotal || 0,
          project: s.project || '—',
          taskTitle: s.taskTitle || '—',
          taskId: s.taskId || null,
          files: s.files || [],
          uptimeSec: s.uptimeSec || 0,
          lastError: s.lastError || null,
        };
      }
    } else if (ev.type === 'phase.transition') {
      const toPhase = ev.data?.to || 'IDLE';
      this.bridgeState.loop.phase = toPhase;
      this.bridgeState.loop.project = ev.data?.projectSlug || this.bridgeState.loop.project;
      this.bridgeState.loop.taskId = ev.data?.taskId || this.bridgeState.loop.taskId;
      if (toPhase !== 'WAIT_HUMAN') {
        this.hitl = null;
      }
    } else if (ev.type === 'hitl.requested') {
      this.hitl = {
        gateType: ev.data?.gateType || 'approval',
        requestId: ev.data?.requestId || 'none',
        details: ev.data?.details || {},
        ts: ev.ts,
        active: true,
      };
    } else if (ev.type === 'hitl.resolved') {
      this.hitl = null;
    }

    if (triggerNotify) {
      this.notify();
    }
  }

  bulkAddEvents(events) {
    for (let i = events.length - 1; i >= 0; i--) {
      this.addEvent(events[i], false);
    }
    this.notify();
  }
}
