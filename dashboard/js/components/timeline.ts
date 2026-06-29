import { escapeHtml as sanitize } from '../utils/sanitize.js';

const PHASES = {
  IDLE:       { cls: 'text-zinc-400 bg-zinc-800/40 border-zinc-700/30', pulse: 'bg-zinc-500',      label: 'Autopilot Idle',        ico: '🟡' },
  DISCOVER:   { cls: 'text-sky-400 bg-sky-500/10 border-sky-500/20',    pulse: 'bg-sky-400 pulse-dot', label: 'Discovering Context',  ico: '🔍' },
  PLAN:       { cls: 'text-purple-400 bg-purple-500/10 border-purple-500/20', pulse: 'bg-purple-400 pulse-dot', label: 'Synthesizing Plan',  ico: '📝' },
  EXEC:       { cls: 'text-blue-400 bg-blue-500/10 border-blue-500/20', pulse: 'bg-blue-400 pulse-dot',   label: 'Executing Task',       ico: '⚙️' },
  QA:         { cls: 'text-warning bg-warning/10 border-warning/20',    pulse: 'bg-warning pulse-dot',    label: 'Running Quality Gate', ico: '🧪' },
  VISUAL_QA:  { cls: 'text-pink-400 bg-pink-500/10 border-pink-500/20', pulse: 'bg-pink-400 pulse-dot',   label: 'Visual QA',             ico: '🎨' },
  WAIT_HUMAN: { cls: 'text-amber-400 bg-amber-500/20 border-amber-500/40', pulse: 'bg-amber-400 pulse-dot', label: 'Awaiting Review',    ico: '⏳' },
  COMMIT:     { cls: 'text-success bg-success/10 border-success/20',    pulse: 'bg-success',              label: 'Committing Changes',    ico: '💾' },
  SYNC:       { cls: 'text-success bg-success/15 border-success/30',    pulse: 'bg-success',              label: 'Syncing Notion',        ico: '☁️' },
  FIX:        { cls: 'text-danger bg-danger/10 border-danger/20',       pulse: 'bg-danger pulse-dot',     label: 'Self-Repairing',        ico: '🔧' },
  THINKING:   { cls: 'text-primary bg-primary/10 border-primary/20',    pulse: 'bg-primary pulse-dot',    label: 'Thinking...',           ico: '💭' },
};

function getPhaseCfg(p) {
  if (!p || p === 'IDLE') return PHASES.IDLE;
  if (p.startsWith('TOOL:')) return { cls: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20', pulse: 'bg-cyan-400 pulse-dot', label: `Tool: ${p.slice(5)}`, ico: '🛠️' };
  return PHASES[p] || { cls: 'text-zinc-400 bg-zinc-800/40 border-zinc-700/30', pulse: 'bg-zinc-500', label: p, ico: '○' };
}

function formatUptime(sec) {
  if (!sec || sec <= 0) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function extractPhase(msg) {
  if (!msg) return null;
  const m = msg.match(/TRANSITIONING TO PHASE:\s*(\w+)/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function fmtToken(n) {
  if (!n) return '0';
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

export function mountTimeline(container, state) {
  container.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <!-- Left -->
      <div class="lg:col-span-7 space-y-3.5">
        <div class="flex items-center justify-between p-3.5 bg-white/[0.01] border border-white/5 rounded-xl">
          <div class="flex flex-col gap-1">
            <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">Orchestrator Phase</span>
            <span id="loop-phase" class="mt-0.5">IDLE</span>
          </div>
          <div class="flex flex-col gap-1 items-end">
            <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">Uptime</span>
            <span id="loop-uptime" class="font-mono text-zinc-300 text-xs font-semibold min-w-[64px] text-right">—</span>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2.5">
          <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-between min-h-[60px]">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Active Project</span>
            <span id="loop-project" class="text-accentBlue font-bold truncate mt-0.5">—</span>
          </div>
          <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-between min-h-[60px]">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Accumulated Cost</span>
            <span id="loop-cost" class="text-success font-bold text-sm mt-0.5 tabular-nums">$0.00</span>
          </div>
          <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-between min-h-[60px]">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Tokens Burned</span>
            <span id="loop-tokens" class="text-purple-400 font-bold text-sm mt-0.5 tabular-nums">0</span>
          </div>
          <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-between min-h-[60px]">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Heartbeat</span>
            <span id="loop-heartbeat" class="text-zinc-500 font-medium text-xs mt-0.5 flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>Offline
            </span>
          </div>
        </div>

        <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Current Task</span>
            <span id="loop-task-id" class="text-[9px] bg-zinc-800/60 text-zinc-400 px-1.5 py-0.5 rounded border border-white/5 select-none hidden font-mono"></span>
          </div>
          <div id="loop-task-title" class="text-zinc-200 font-medium text-xs leading-relaxed break-words">—</div>
          <div class="pt-1 space-y-1.5">
            <div class="flex justify-between text-[9px] font-bold text-zinc-500 uppercase tracking-wider">
              <span>Progress</span>
              <span id="loop-progress-pct">0%</span>
            </div>
            <div class="w-full bg-zinc-800/40 rounded-full h-2 overflow-hidden border border-white/5">
              <div id="loop-progress-bar" class="h-full rounded-full bg-gradient-to-r from-primary to-accentBlue transition-all duration-700 ease-out" style="width:0%"></div>
            </div>
            <div class="flex justify-between text-[10px] text-zinc-500 pt-0.5" id="loop-task-counts">
              <span>Done: <strong class="text-success font-semibold">0</strong></span>
              <span>Blocked: <strong class="text-warning font-semibold">0</strong></span>
              <span>Total: <strong class="text-zinc-300 font-semibold">0</strong></span>
            </div>
          </div>
        </div>

        <div id="loop-files-panel" class="bg-white/[0.01] border border-white/5 rounded-xl p-4 space-y-2 hidden">
          <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px] block">Modified Files</span>
          <div id="loop-files-list" class="space-y-1 max-h-24 overflow-y-auto custom-scrollbar text-[11px]"></div>
        </div>

        <div id="loop-error-panel" class="bg-danger/5 border border-danger/20 rounded-xl p-4 hidden">
          <span class="text-danger font-bold uppercase tracking-wider text-[9px] block mb-1">
            <span class="inline-flex items-center gap-1">⚠ Error</span>
          </span>
          <p id="loop-error-text" class="text-xs text-danger/80 leading-relaxed font-mono break-words"></p>
        </div>
      </div>

      <!-- Right: Timeline -->
      <div class="lg:col-span-5 flex flex-col">
        <div class="flex items-center justify-between mb-3">
          <h4 class="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Activity Timeline</h4>
          <span id="timeline-count" class="text-[9px] text-zinc-600 font-mono"></span>
        </div>
        <div class="flex-1 relative pl-5 border-l border-white/[0.06] space-y-0 max-h-[360px] overflow-y-auto custom-scrollbar" id="timeline-list">
          <div class="text-zinc-600 text-xs py-3 select-none font-medium">No phase history logged</div>
        </div>
      </div>
    </div>
  `;

  const els = {
    phaseEl: container.querySelector('#loop-phase'),
    uptimeEl: container.querySelector('#loop-uptime'),
    projectEl: container.querySelector('#loop-project'),
    heartbeatEl: container.querySelector('#loop-heartbeat'),
    taskTitleEl: container.querySelector('#loop-task-title'),
    taskIdEl: container.querySelector('#loop-task-id'),
    costEl: container.querySelector('#loop-cost'),
    tokensEl: container.querySelector('#loop-tokens'),
    progressPct: container.querySelector('#loop-progress-pct'),
    progressBar: container.querySelector('#loop-progress-bar'),
    taskCounts: container.querySelector('#loop-task-counts'),
    filesPanel: container.querySelector('#loop-files-panel'),
    filesList: container.querySelector('#loop-files-list'),
    errorPanel: container.querySelector('#loop-error-panel'),
    errorText: container.querySelector('#loop-error-text'),
    timelineList: container.querySelector('#timeline-list'),
    timelineCount: container.querySelector('#timeline-count'),
  };

  let _uptimeSec = 0, _uptimeInterval = null;
  let _lastHash = '', _lastCount = -1;

  function startUptime(base) {
    if (_uptimeInterval) clearInterval(_uptimeInterval);
    _uptimeSec = base || 0;
    els.uptimeEl.textContent = formatUptime(_uptimeSec);
    if (base > 0) {
      _uptimeInterval = setInterval(() => {
        _uptimeSec++;
        els.uptimeEl.textContent = formatUptime(_uptimeSec);
      }, 1000);
    }
  }

  function stopUptime() {
    if (_uptimeInterval) { clearInterval(_uptimeInterval); _uptimeInterval = null; }
    _uptimeSec = 0;
    els.uptimeEl.textContent = '—';
  }

  function updateState() {
    const loop = state.bridgeState?.loop || {};
    const phase = loop.phase || 'IDLE';
    const running = loop.running || phase !== 'IDLE';
    const cfg = getPhaseCfg(phase);

    els.phaseEl.className = `px-3 py-1.5 rounded-lg border ${cfg.cls} text-[11px] font-bold tracking-wide inline-flex items-center gap-2 shadow-sm`;
    els.phaseEl.innerHTML = `<span class="w-2 h-2 rounded-full ${cfg.pulse}"></span>${cfg.ico} ${sanitize(cfg.label)}`;

    if (running) {
      startUptime(loop.uptimeSec || 0);
      els.heartbeatEl.className = 'text-success font-semibold text-xs mt-0.5 flex items-center gap-1.5';
      els.heartbeatEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-success pulse-dot"></span>Active';
    } else {
      stopUptime();
      els.heartbeatEl.className = 'text-zinc-500 font-medium text-xs mt-0.5 flex items-center gap-1.5';
      els.heartbeatEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>Offline';
    }

    els.projectEl.textContent = loop.project || '—';
    els.projectEl.className = (loop.project && loop.project !== '—' ? 'text-accentBlue' : 'text-zinc-500') + ' font-bold truncate mt-0.5';

    els.costEl.textContent = `$${(loop.cost || 0).toFixed(2)}`;
    els.tokensEl.textContent = fmtToken(loop.tokens || 0);

    els.taskTitleEl.textContent = loop.taskTitle || 'Waiting for active tasks in loop...';

    if (loop.taskId) {
      els.taskIdEl.textContent = `ID: ${loop.taskId}`;
      els.taskIdEl.classList.remove('hidden');
    } else {
      els.taskIdEl.classList.add('hidden');
    }

    const completed = loop.tasksCompleted || 0;
    const blocked = loop.tasksBlocked || 0;
    const total = loop.tasksTotal || 0;
    els.taskCounts.innerHTML = `
      <span>Done: <strong class="text-success font-semibold">${completed}</strong></span>
      <span>Blocked: <strong class="text-warning font-semibold">${blocked}</strong></span>
      <span>Total: <strong class="text-zinc-300 font-semibold">${total}</strong></span>`;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    els.progressPct.textContent = `${pct}%`;
    els.progressBar.style.width = `${pct}%`;

    if (loop.files && Array.isArray(loop.files) && loop.files.length > 0) {
      els.filesPanel.classList.remove('hidden');
      els.filesList.innerHTML = loop.files.map(f => {
        const name = typeof f === 'string' ? f : f.path || f.file || 'file';
        const add = typeof f === 'string' ? 0 : f.additions || f.added || 0;
        const del = typeof f === 'string' ? 0 : f.deletions || f.removed || 0;
        return `<div class="flex items-center justify-between py-1.5 border-b border-white/[0.02] last:border-b-0">
          <span class="text-zinc-300 font-mono truncate select-all pr-2 text-[11px]" title="${sanitize(name)}">${sanitize(name.split('/').pop())}</span>
          <div class="flex items-center gap-1 text-[9px] font-bold shrink-0">
            ${add > 0 ? `<span class="text-success bg-success/10 px-1.5 py-0.5 rounded border border-success/15">+${add}</span>` : ''}
            ${del > 0 ? `<span class="text-danger bg-danger/10 px-1.5 py-0.5 rounded border border-danger/15">-${del}</span>` : ''}
          </div>
        </div>`;
      }).join('');
    } else {
      els.filesPanel.classList.add('hidden');
    }

    if (loop.lastError) {
      els.errorPanel.classList.remove('hidden');
      els.errorText.textContent = loop.lastError;
    } else {
      els.errorPanel.classList.add('hidden');
    }
  }

  function updateTimeline() {
    const entries = state.events
      .filter(e => e.type === 'phase.transition' || (e.source === 'orchestrator' && /(?:phase|transition)/i.test(e.message)))
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, 20);

    const hash = entries.map(e => `${e.id || ''}:${e.ts}:${e.message}`).join('|');
    if (entries.length === _lastCount && hash === _lastHash && _lastCount >= 0) return;
    _lastCount = entries.length;
    _lastHash = hash;

    if (entries.length === 0) {
      els.timelineList.innerHTML = '<div class="text-zinc-600 text-xs py-3 select-none font-medium">No activity recorded yet</div>';
      els.timelineCount.textContent = '';
      return;
    }

    els.timelineCount.textContent = `${entries.length} events`;

    els.timelineList.innerHTML = entries.map((e, i) => {
      const isLatest = i === 0;
      const rawPhase = e.data?.to || extractPhase(e.message) || (e.message || '').replace(/^\[.*?\]\s*/, '').trim();
      const cfg = getPhaseCfg(rawPhase || e.message);
      const isError = /error|crash|fail/i.test(e.message || '');
      const d = new Date(e.ts);
      const time = d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const dotCls = isError ? 'bg-danger pulse-dot' : isLatest ? 'bg-primary pulse-dot' : cfg.pulse || 'bg-zinc-600';

      return `<div class="tl-item ${isLatest ? 'active opacity-100' : 'opacity-40 hover:opacity-80'} flex items-center justify-between text-[11px] py-1.5 transition-all duration-300 origin-left" style="${isLatest ? '' : ''}">
        <div class="flex items-center gap-2.5 min-w-0 flex-1">
          <span class="w-2 h-2 rounded-full ${dotCls} border border-white/10 shrink-0"></span>
          <span class="text-zinc-500 font-mono select-none shrink-0 w-[60px]">${time}</span>
          ${rawPhase
            ? `<span class="font-bold uppercase tracking-wide text-zinc-300 truncate">${sanitize(rawPhase)}</span>`
            : `<span class="text-zinc-500 truncate">${sanitize((e.message || '').slice(0, 60))}</span>`}
        </div>
        <div class="flex items-center gap-1.5 shrink-0 ml-2">
          ${cfg.ico !== '○' ? `<span class="text-[10px]">${cfg.ico}</span>` : ''}
          ${e.data?.projectSlug ? `<span class="text-[9px] bg-zinc-800/50 text-zinc-500 px-1.5 py-0.5 rounded border border-white/5">${sanitize(e.data.projectSlug)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  const handleUpdate = () => {
    if (state.activeTab !== 'overview') return;
    updateState();
    updateTimeline();
  };

  state.subscribe(handleUpdate);
  handleUpdate();
}