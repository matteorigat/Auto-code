import { escapeHtml as sanitize } from '../utils/sanitize.mjs';

export function mountTimeline(container, state) {
  // Setup HTML shell once
  container.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-12 gap-6">
      <!-- Left side: Status & active task details (cols 7) -->
      <div class="md:col-span-7 space-y-4">
        <!-- Top Status Bar & Phase Name -->
        <div class="flex items-center justify-between p-3.5 bg-white/[0.01] border border-white/5 rounded-xl">
           <div class="flex flex-col">
             <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">Orchestrator Phase</span>
             <span id="loop-phase" class="mt-1">IDLE</span>
           </div>
           <div class="flex flex-col items-end">
             <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">Uptime Clock</span>
             <span id="loop-uptime" class="mt-1 font-mono text-zinc-300 text-xs font-semibold">—</span>
           </div>
        </div>

        <!-- 4-metric grid -->
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-between h-16">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Active Project</span>
            <span id="loop-project" class="text-accentBlue font-bold truncate mt-0.5">—</span>
          </div>
          <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-between h-16">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Accumulated Cost</span>
            <span id="loop-cost" class="text-success font-bold text-sm mt-0.5">$0.00</span>
          </div>
          <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-between h-16">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Tokens Burned</span>
            <span id="loop-tokens" class="text-purple-400 font-bold text-sm mt-0.5">0</span>
          </div>
          <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-between h-16">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Heartbeat Status</span>
            <span id="loop-heartbeat" class="text-zinc-400 font-medium text-xs mt-0.5 flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>Offline
            </span>
          </div>
        </div>

        <!-- Active task details & progress bar -->
        <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px]">Current Task</span>
            <span id="loop-task-id" class="text-[9px] bg-zinc-850/60 text-zinc-400 px-1.5 py-0.5 rounded border border-white/5 select-none hidden"></span>
          </div>
          <div id="loop-task-title" class="text-zinc-200 font-medium text-xs break-words leading-relaxed">—</div>
          
          <!-- Progress bar -->
          <div class="space-y-1.5 pt-1">
            <div class="flex justify-between text-[9px] font-bold text-zinc-500 uppercase">
              <span>Task Completion</span>
              <span id="loop-progress-pct">0%</span>
            </div>
            <div class="w-full bg-zinc-800/40 rounded-full h-1.5 overflow-hidden border border-white/5">
              <div id="loop-progress-bar" class="bg-gradient-to-r from-primary to-accentBlue h-full rounded-full transition-all duration-500" style="width: 0%"></div>
            </div>
            <div class="flex justify-between text-[10px] text-zinc-400 pt-0.5" id="loop-task-counts">
              <span>Completed: 0</span>
              <span>Blocked: 0</span>
              <span>Total: 0</span>
            </div>
          </div>
        </div>

        <!-- Modified files panel -->
        <div id="loop-files-panel" class="bg-white/[0.01] border border-white/5 rounded-xl p-4 space-y-2 hidden">
          <span class="text-zinc-500 font-bold uppercase tracking-wider text-[9px] block">Modified Files</span>
          <div id="loop-files-list" class="space-y-1.5 max-h-24 overflow-y-auto custom-scrollbar text-[11px]">
          </div>
        </div>

        <!-- Error panel -->
        <div id="loop-error-panel" class="bg-danger/5 border border-danger/20 rounded-xl p-4 hidden">
          <span class="text-danger font-bold uppercase tracking-wider text-[9px] block mb-1">Last Error Details</span>
          <p id="loop-error-text" class="text-xs text-danger/80 break-words leading-relaxed font-mono"></p>
        </div>
      </div>

      <!-- Right side: Phase Transitions Timeline (cols 5) -->
      <div class="md:col-span-5 flex flex-col">
        <h4 class="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-3">Orchestrator Activity Timeline</h4>
        <div class="flex-1 relative pl-4 border-l border-white/10 space-y-4 max-h-[340px] overflow-y-auto custom-scrollbar" id="timeline-list">
          <div class="text-zinc-600 text-xs py-2 select-none font-medium">No phase history logged</div>
        </div>
      </div>
    </div>
  `;

  const projectEl = container.querySelector('#loop-project');
  const phaseEl = container.querySelector('#loop-phase');
  const taskTitleEl = container.querySelector('#loop-task-title');
  const listEl = container.querySelector('#timeline-list');

  let lastKnownEventCount = -1;
  let lastKnownEventsHash = '';

  const updateStateInfo = () => {
    const loop = state.bridgeState?.loop || {};

    // 1. Update Project
    projectEl.textContent = loop.project || '—';
    if (loop.project && loop.project !== '—') {
      projectEl.className = 'text-accentBlue font-bold truncate mt-0.5';
    } else {
      projectEl.className = 'text-zinc-500 truncate mt-0.5';
    }

    // 2. Update Phase (status badge)
    const phase = loop.phase || 'IDLE';
    let phaseClass = 'text-zinc-400 bg-zinc-800/30 border-zinc-700/50';
    let pulseClass = 'bg-zinc-500';
    let phaseText = phase;

    // Premium phase styling
    if (phase === 'IDLE') {
      phaseClass = 'text-zinc-400 bg-zinc-800/40 border-zinc-700/30';
      pulseClass = 'bg-zinc-500';
      phaseText = '🟡 Autopilot Idle';
    } else if (phase === 'PLAN') {
      phaseClass = 'text-purple-400 bg-purple-500/10 border-purple-500/20';
      pulseClass = 'bg-purple-400 pulse-dot';
      phaseText = '📝 Synthesizing Plan';
    } else if (phase === 'EXEC') {
      phaseClass = 'text-accentBlue bg-accentBlue/10 border-accentBlue/20';
      pulseClass = 'bg-accentBlue pulse-dot';
      phaseText = '⚙️ Executing Task';
    } else if (phase === 'QA') {
      phaseClass = 'text-warning bg-warning/10 border-warning/20';
      pulseClass = 'bg-warning pulse-dot';
      phaseText = '🧪 Running Quality Gate';
    } else if (phase === 'VISUAL_QA') {
      phaseClass = 'text-pink-400 bg-pink-500/10 border-pink-500/20';
      pulseClass = 'bg-pink-400 pulse-dot';
      phaseText = '🎨 Running Visual QA';
    } else if (phase === 'WAIT_HUMAN') {
      phaseClass = 'text-amber-400 bg-amber-500/20 border-amber-500/40';
      pulseClass = 'bg-amber-400 pulse-dot';
      phaseText = '⏳ Waiting for Review';
    } else if (phase === 'COMMIT') {
      phaseClass = 'text-success bg-success/10 border-success/20';
      pulseClass = 'bg-success';
      phaseText = '💾 Committing Changes';
    } else if (phase === 'SYNC') {
      phaseClass = 'text-success bg-success/15 border-success/30';
      pulseClass = 'bg-success';
      phaseText = '☁️ Syncing Notion';
    } else if (phase === 'FIX') {
      phaseClass = 'text-danger bg-danger/10 border-danger/20';
      pulseClass = 'bg-danger pulse-dot';
      phaseText = '🔧 Self-Repairing (Fix)';
    } else if (phase === 'THINKING') {
      phaseClass = 'text-primary bg-primary/10 border-primary/20';
      pulseClass = 'bg-primary pulse-dot';
      phaseText = '💭 Thinking...';
    } else if (phase.startsWith('TOOL:')) {
      phaseClass = 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20';
      pulseClass = 'bg-cyan-400 pulse-dot';
      phaseText = `🛠️ Tool: ${phase.substring(5)}`;
    }

    phaseEl.className = `px-3 py-1 rounded-lg border ${phaseClass} text-[11px] font-bold tracking-wide uppercase inline-flex items-center gap-2 shadow-sm`;
    phaseEl.innerHTML = `<span class="w-2 h-2 rounded-full ${pulseClass}"></span>${sanitize(phaseText)}`;

    // 3. Heartbeat Indicator
    const hbEl = container.querySelector('#loop-heartbeat');
    if (loop.running || phase !== 'IDLE') {
      hbEl.className = 'text-success font-semibold text-xs mt-0.5 flex items-center gap-1.5';
      hbEl.innerHTML =
        '<span class="w-1.5 h-1.5 rounded-full bg-success bg-gradient-to-r from-success to-emerald-400 pulse-dot"></span>Active';
    } else {
      hbEl.className = 'text-zinc-500 font-medium text-xs mt-0.5 flex items-center gap-1.5';
      hbEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-zinc-700"></span>Offline';
    }

    // 4. Update Uptime
    const uptimeEl = container.querySelector('#loop-uptime');
    if (loop.uptimeSec && loop.uptimeSec > 0) {
      const h = Math.floor(loop.uptimeSec / 3600);
      const m = Math.floor((loop.uptimeSec % 3600) / 60);
      const s = loop.uptimeSec % 60;
      uptimeEl.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    } else if (loop.running) {
      uptimeEl.textContent = 'Active';
    } else {
      uptimeEl.textContent = '—';
    }

    // 5. Update Cost & Tokens
    container.querySelector('#loop-cost').textContent = `$${(loop.cost || 0).toFixed(2)}`;

    const tokens = loop.tokens || 0;
    const tokenStr =
      tokens >= 1000000
        ? (tokens / 1000000).toFixed(2) + 'M'
        : tokens >= 1000
          ? (tokens / 1000).toFixed(1) + 'k'
          : tokens;
    container.querySelector('#loop-tokens').textContent = tokenStr;

    // 6. Update Task Title & ID
    taskTitleEl.textContent = loop.taskTitle || 'Waiting for active tasks in loop...';

    const taskIdEl = container.querySelector('#loop-task-id');
    if (loop.taskId) {
      taskIdEl.textContent = `ID: ${loop.taskId}`;
      taskIdEl.classList.remove('hidden');
    } else {
      taskIdEl.classList.add('hidden');
    }

    // 7. Update Task Counts & Progress Bar
    const completed = loop.tasksCompleted || 0;
    const blocked = loop.tasksBlocked || 0;
    const total = loop.tasksTotal || 0;

    const countsEl = container.querySelector('#loop-task-counts');
    countsEl.innerHTML = `
      <span>Completed: <strong class="text-success font-semibold">${completed}</strong></span>
      <span>Blocked: <strong class="text-warning font-semibold">${blocked}</strong></span>
      <span>Total: <strong class="text-zinc-200 font-semibold">${total}</strong></span>
    `;

    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    container.querySelector('#loop-progress-pct').textContent = `${pct}%`;
    container.querySelector('#loop-progress-bar').style.width = `${pct}%`;

    // 8. Update Files Panel
    const filesPanel = container.querySelector('#loop-files-panel');
    const filesList = container.querySelector('#loop-files-list');
    if (loop.files && Array.isArray(loop.files) && loop.files.length > 0) {
      filesPanel.classList.remove('hidden');
      filesList.innerHTML = loop.files
        .map((f) => {
          const name = typeof f === 'string' ? f : f.path || f.file || 'file';
          const add = typeof f === 'string' ? 0 : f.additions || f.added || 0;
          const del = typeof f === 'string' ? 0 : f.deletions || f.removed || 0;
          return `
          <div class="flex items-center justify-between py-1.5 border-b border-white/[0.02] last:border-b-0">
            <span class="text-zinc-300 font-mono truncate select-all pr-2" title="${sanitize(name)}">${sanitize(name.split('/').pop())}</span>
            <div class="flex items-center gap-1.5 text-[9px] font-bold flex-shrink-0">
              ${add > 0 ? `<span class="text-success bg-success/10 px-1 py-0.5 rounded border border-success/15">+${add}</span>` : ''}
              ${del > 0 ? `<span class="text-danger bg-danger/10 px-1 py-0.5 rounded border border-danger/15">-${del}</span>` : ''}
            </div>
          </div>
        `;
        })
        .join('');
    } else {
      filesPanel.classList.add('hidden');
    }

    // 9. Update Error Panel
    const errorPanel = container.querySelector('#loop-error-panel');
    const errorText = container.querySelector('#loop-error-text');
    if (loop.lastError) {
      errorPanel.classList.remove('hidden');
      errorText.textContent = loop.lastError;
    } else {
      errorPanel.classList.add('hidden');
    }
  };

  const updateTransitionsList = () => {
    // Extract recent phase transitions from state.events
    const phases = state.events
      .filter(
        (e) =>
          e.type === 'phase.transition' ||
          (e.source === 'orchestrator' && e.message.includes('phase')),
      )
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 15);

    const quickHash = phases.map((e) => `${e.id || ''}:${e.ts}`).join('|');
    if (
      phases.length === lastKnownEventCount &&
      lastKnownEventCount !== 0 &&
      quickHash === lastKnownEventsHash
    )
      return;
    lastKnownEventCount = phases.length;
    lastKnownEventsHash = quickHash;

    if (phases.length === 0) {
      listEl.innerHTML =
        '<div class="text-zinc-600 text-xs py-2 select-none font-medium">No phase history logged</div>';
      return;
    }

    listEl.innerHTML = phases
      .map((ev, i) => {
        const isLatest = i === 0;
        const d = new Date(ev.ts);
        const timeStr = d.toLocaleTimeString([], {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

        const phaseStr = sanitize(ev.data?.to || ev.message || 'UNKNOWN');
        const isError = phaseStr.includes('ERROR') || phaseStr.includes('CRASH');

        let dotColor = 'bg-zinc-600';
        if (isError) dotColor = 'bg-danger pulse-dot';
        else if (phaseStr === 'EXEC') dotColor = 'bg-accentBlue pulse-dot';
        else if (phaseStr === 'QA') dotColor = 'bg-warning pulse-dot';
        else if (phaseStr === 'COMMIT' || phaseStr === 'SYNC') dotColor = 'bg-success';
        else if (phaseStr === 'IDLE') dotColor = 'bg-zinc-500';
        else if (isLatest) dotColor = 'bg-primary pulse-dot';

        return `
        <div class="timeline-item ${isLatest ? 'active opacity-100 scale-100 font-medium' : 'opacity-50 hover:opacity-80 scale-95'} origin-left flex items-center justify-between text-[11px] py-1 transition-all duration-200">
          <div class="flex items-center gap-2.5">
            <span class="w-2 h-2 rounded-full ${dotColor} border border-white/10 flex-shrink-0"></span>
            <span class="text-zinc-500 font-mono select-none">${timeStr}</span>
            <span class="font-bold uppercase text-zinc-300 tracking-wide">${phaseStr}</span>
          </div>
          ${ev.data?.projectSlug ? `<span class="text-[9px] bg-zinc-800/40 text-zinc-500 px-1 rounded select-none border border-white/5">${sanitize(ev.data.projectSlug)}</span>` : ''}
        </div>
      `;
      })
      .join('');
  };

  const handleUpdate = () => {
    if (state.activeTab !== 'overview') return;
    updateStateInfo();
    updateTransitionsList();
  };

  state.subscribe(handleUpdate);
  handleUpdate();
}
