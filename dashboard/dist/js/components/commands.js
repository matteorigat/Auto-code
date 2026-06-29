const SVG_LOOP = '<svg class="w-4 h-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><path d="M21 3v5h-5"/></svg>';
const SVG_PROC = '<svg class="w-4 h-4 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const SVG_PAUSE = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const SVG_PLAY = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>';
const SVG_STOP = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>';
const SVG_SKIP = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="6 4 18 12 6 20 6 4"/><line x1="18" y1="5" x2="18" y2="19"/></svg>';
export function mountCommands(container, state, api) {
    container.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- LEFT: Loop Controls -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
            ${SVG_LOOP}
            Orchestrator Loop
          </h3>
          <div id="loop-status-badge" class="flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full bg-zinc-800/50 border border-zinc-700/30 select-none">
            <span id="loop-status-dot" class="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>
            <span id="loop-status-text" class="text-zinc-500">Offline</span>
          </div>
        </div>

        <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3.5 space-y-2.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">Phase</span>
              <span id="loop-phase-badge" class="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-zinc-800/40 text-zinc-400 border border-zinc-700/30">IDLE</span>
            </div>
            <div class="flex items-center gap-2.5">
              <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">Uptime</span>
              <span id="loop-uptime" class="font-mono text-zinc-300 text-[11px] font-semibold min-w-[60px] text-right">—</span>
            </div>
          </div>
          <div class="flex items-center gap-2 text-[10px] text-zinc-500">
            <span id="loop-heartbeat" class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>Inactive</span>
            <span class="text-zinc-700">·</span>
            <span id="loop-project-label">Project: —</span>
          </div>
        </div>

        <div id="loop-actions" class="grid grid-cols-2 gap-2">
          <button id="cmd-pause" class="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-bold transition-all duration-200 outline-none bg-zinc-800/40 border border-zinc-700/30 text-zinc-400 cursor-not-allowed" disabled>
            ${SVG_PAUSE}Pause
          </button>
          <button id="cmd-resume" class="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-bold transition-all duration-200 outline-none bg-zinc-800/40 border border-zinc-700/30 text-zinc-400 cursor-not-allowed" disabled>
            ${SVG_PLAY}Resume
          </button>
          <button id="cmd-stop" class="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-bold transition-all duration-200 outline-none bg-zinc-800/40 border border-zinc-700/30 text-zinc-400 cursor-not-allowed col-span-2" disabled>
            ${SVG_STOP}Stop Orchestrator
          </button>
        </div>

        <div id="loop-start-section" class="bg-white/[0.01] border border-white/5 rounded-xl p-3.5 space-y-2.5 transition-all duration-300">
          <div class="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">Start Loop on Project</div>
          <div class="flex gap-2">
            <div class="relative flex-1">
              <input id="cmd-project-input" type="text" placeholder="Project slug or leave empty for 'loop'..." autocomplete="off" class="w-full bg-zinc-800/60 border border-zinc-700/50 text-xs rounded-lg px-3 py-2 outline-none focus:border-primary/50 text-zinc-200 placeholder-zinc-600 transition-colors" />
              <div id="project-suggestions" class="absolute top-full left-0 right-0 mt-1 bg-zinc-800/95 backdrop-blur-xl border border-zinc-700/50 rounded-lg shadow-xl z-20 hidden max-h-36 overflow-y-auto custom-scrollbar"></div>
            </div>
            <button id="cmd-start-loop" class="flex items-center gap-1.5 py-2 px-4 rounded-lg bg-primary hover:bg-primary/80 active:scale-[0.97] transition-all text-xs font-bold text-white outline-none disabled:opacity-40 disabled:cursor-not-allowed" disabled>
              ${SVG_PLAY}Start
            </button>
          </div>
          <div class="text-[9px] text-zinc-600">Projects are auto-discovered from sibling directories</div>
        </div>
      </div>

      <!-- RIGHT: Process Managers -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
            ${SVG_PROC}
            Core Process Managers
          </h3>
          <div class="flex gap-1.5">
            <button id="proc-stop-all" class="text-[9px] font-bold px-2 py-1 rounded-md bg-danger/5 text-danger/70 hover:bg-danger/15 hover:text-danger border border-danger/10 transition outline-none disabled:opacity-30 disabled:cursor-not-allowed">Stop All</button>
            <button id="proc-restart-all" class="text-[9px] font-bold px-2 py-1 rounded-md bg-zinc-800/40 text-zinc-400 hover:bg-zinc-700/40 hover:text-zinc-300 border border-zinc-700/30 transition outline-none disabled:opacity-30 disabled:cursor-not-allowed">Restart All</button>
          </div>
        </div>

        <div id="process-list" class="space-y-2"></div>

        <div id="no-proc-msg" class="text-[11px] text-zinc-600 text-center py-3 bg-white/[0.01] border border-white/5 rounded-xl hidden">
          No process data available yet
        </div>
      </div>
    </div>
  `;
    const els = {
        phaseBadge: container.querySelector('#loop-phase-badge'),
        uptime: container.querySelector('#loop-uptime'),
        heartbeat: container.querySelector('#loop-heartbeat'),
        statusDot: container.querySelector('#loop-status-dot'),
        statusText: container.querySelector('#loop-status-text'),
        statusBadge: container.querySelector('#loop-status-badge'),
        projectLabel: container.querySelector('#loop-project-label'),
        cmdPause: container.querySelector('#cmd-pause'),
        cmdResume: container.querySelector('#cmd-resume'),
        cmdStop: container.querySelector('#cmd-stop'),
        cmdStart: container.querySelector('#cmd-start-loop'),
        cmdProjectInput: container.querySelector('#cmd-project-input'),
        projectSuggestions: container.querySelector('#project-suggestions'),
        startSection: container.querySelector('#loop-start-section'),
        loopActions: container.querySelector('#loop-actions'),
        processList: container.querySelector('#process-list'),
        noProcMsg: container.querySelector('#no-proc-msg'),
        procStopAll: container.querySelector('#proc-stop-all'),
        procRestartAll: container.querySelector('#proc-restart-all'),
    };
    let _projects = [];
    let _isPaused = false;
    let _stopConfirm = false;
    let _uptimeSec = 0;
    let _uptimeInterval = null;
    let _projectFetchAttempted = false;
    const phaseConfig = {
        IDLE: { cls: 'text-zinc-400 bg-zinc-800/40 border-zinc-700/30', pulse: 'bg-zinc-500', label: 'Idle' },
        PLAN: { cls: 'text-purple-400 bg-purple-500/10 border-purple-500/20', pulse: 'bg-purple-400 pulse-dot', label: 'Planning' },
        EXEC: { cls: 'text-blue-400 bg-blue-500/10 border-blue-500/20', pulse: 'bg-blue-400 pulse-dot', label: 'Executing Task' },
        QA: { cls: 'text-warning bg-warning/10 border-warning/20', pulse: 'bg-warning pulse-dot', label: 'Quality Gate' },
        VISUAL_QA: { cls: 'text-pink-400 bg-pink-500/10 border-pink-500/20', pulse: 'bg-pink-400 pulse-dot', label: 'Visual QA' },
        WAIT_HUMAN: { cls: 'text-amber-400 bg-amber-500/20 border-amber-500/40', pulse: 'bg-amber-400 pulse-dot', label: 'Awaiting Review' },
        COMMIT: { cls: 'text-success bg-success/10 border-success/20', pulse: 'bg-success', label: 'Committing' },
        SYNC: { cls: 'text-success bg-success/15 border-success/30', pulse: 'bg-success', label: 'Syncing Notion' },
        FIX: { cls: 'text-danger bg-danger/10 border-danger/20', pulse: 'bg-danger pulse-dot', label: 'Self-Repairing' },
        THINKING: { cls: 'text-primary bg-primary/10 border-primary/20', pulse: 'bg-primary pulse-dot', label: 'Thinking' },
    };
    function getPhaseConfig(phase) {
        if (!phase || phase === 'IDLE')
            return phaseConfig.IDLE;
        if (phase.startsWith('TOOL:')) {
            return { cls: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20', pulse: 'bg-cyan-400 pulse-dot', label: `Tool: ${phase.slice(5)}` };
        }
        return phaseConfig[phase] || { cls: 'text-zinc-400 bg-zinc-800/40 border-zinc-700/30', pulse: 'bg-zinc-500', label: phase };
    }
    function formatUptime(sec) {
        if (!sec || sec <= 0)
            return '—';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    function updateUptimeDisplay() {
        els.uptime.textContent = formatUptime(_uptimeSec);
    }
    function startUptimeCounter(base) {
        if (_uptimeInterval)
            clearInterval(_uptimeInterval);
        _uptimeSec = base || 0;
        updateUptimeDisplay();
        if (base > 0) {
            _uptimeInterval = setInterval(() => {
                _uptimeSec++;
                updateUptimeDisplay();
            }, 1000);
        }
    }
    function stopUptimeCounter() {
        if (_uptimeInterval) {
            clearInterval(_uptimeInterval);
            _uptimeInterval = null;
        }
    }
    function phaseText(phase) {
        const cfg = getPhaseConfig(phase);
        return cfg.label;
    }
    function executeCommand(cmd, btn, extra = {}) {
        const origHTML = btn.innerHTML;
        btn.innerHTML = '<div class="w-4 h-4 rounded-full border-2 border-zinc-400 border-t-transparent animate-spin mx-auto"></div>';
        btn.disabled = true;
        return api.post('/bridge-cmd', { cmd, ...extra }).then(() => {
            btn.innerHTML = '<span class="text-success text-xs font-bold">✓</span>';
        }).catch(() => {
            btn.innerHTML = '<span class="text-danger text-xs font-bold">✗</span>';
        }).finally(() => {
            setTimeout(() => {
                btn.innerHTML = origHTML;
                btn.disabled = false;
            }, 1200);
        });
    }
    function executeProcessCmd(processName, action, btn) {
        const origHTML = btn.innerHTML;
        btn.innerHTML = '<div class="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin mx-auto"></div>';
        btn.disabled = true;
        return api.post('/process-cmd', { processName, action }).then(() => {
            btn.innerHTML = '<span class="text-success">✓</span>';
        }).catch(() => {
            btn.innerHTML = '<span class="text-danger">✗</span>';
        }).finally(() => {
            setTimeout(() => {
                btn.innerHTML = origHTML;
                btn.disabled = false;
            }, 1000);
        });
    }
    function setBtnEnabled(btn, enabled, extraCls = '') {
        if (enabled) {
            btn.disabled = false;
            btn.className = `flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-bold transition-all duration-200 outline-none active:scale-[0.97] ${extraCls}`;
        }
        else {
            btn.disabled = true;
            btn.className = `flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-bold transition-all duration-200 outline-none bg-zinc-800/40 border border-zinc-700/30 text-zinc-400 cursor-not-allowed ${extraCls}`;
        }
    }
    function setStopBtnArmed(armed) {
        if (armed) {
            _stopConfirm = true;
            els.cmdStop.className = 'flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-bold transition-all duration-200 outline-none active:scale-[0.97] bg-danger/20 border-2 border-danger/50 text-danger font-extrabold col-span-2';
            els.cmdStop.innerHTML = `${SVG_STOP}Confirm Stop?`;
            setTimeout(() => {
                if (_stopConfirm) {
                    _stopConfirm = false;
                    updateLoopActions();
                }
            }, 4000);
        }
        else {
            _stopConfirm = false;
            updateLoopActions();
        }
    }
    function updateLoopActions() {
        const loop = state.bridgeState?.loop || {};
        const running = loop.running || (loop.phase && loop.phase !== 'IDLE');
        const phase = loop.phase || 'IDLE';
        const isPaused = _isPaused;
        if (running && !isPaused) {
            setBtnEnabled(els.cmdPause, true, 'bg-warning/10 hover:bg-warning/20 text-warning border border-warning/20');
            els.cmdPause.innerHTML = `${SVG_PAUSE}Pause Loop`;
            setBtnEnabled(els.cmdResume, true, 'bg-zinc-800/40 border border-zinc-700/30 text-zinc-500');
            els.cmdResume.innerHTML = `${SVG_PLAY}Resume`;
            setBtnEnabled(els.cmdStop, true, 'bg-danger/10 hover:bg-danger/20 text-danger/90 border border-danger/20 col-span-2');
            els.cmdStop.innerHTML = `${SVG_STOP}Stop Orchestrator`;
            _stopConfirm = false;
            els.startSection.classList.add('opacity-40', 'pointer-events-none');
        }
        else if (running && isPaused) {
            setBtnEnabled(els.cmdPause, true, 'bg-zinc-800/40 border border-zinc-700/30 text-zinc-500');
            els.cmdPause.innerHTML = `${SVG_PAUSE}Pause`;
            setBtnEnabled(els.cmdResume, true, 'bg-success/10 hover:bg-success/20 text-success border border-success/20');
            els.cmdResume.innerHTML = `${SVG_PLAY}Resume Loop`;
            setBtnEnabled(els.cmdStop, true, 'bg-danger/10 hover:bg-danger/20 text-danger/90 border border-danger/20 col-span-2');
            els.cmdStop.innerHTML = `${SVG_STOP}Stop Orchestrator`;
            _stopConfirm = false;
            els.startSection.classList.add('opacity-40', 'pointer-events-none');
        }
        else {
            setBtnEnabled(els.cmdPause, false);
            els.cmdPause.innerHTML = `${SVG_PAUSE}Pause`;
            setBtnEnabled(els.cmdResume, false);
            els.cmdResume.innerHTML = `${SVG_PLAY}Resume`;
            setBtnEnabled(els.cmdStop, false);
            els.cmdStop.innerHTML = `${SVG_STOP}Stop Orchestrator`;
            _stopConfirm = false;
            els.startSection.classList.remove('opacity-40', 'pointer-events-none');
            const val = els.cmdProjectInput.value.trim();
            els.cmdStart.disabled = false;
        }
    }
    function setStatusBadge(dotClass, text, textClass) {
        els.statusDot.className = `w-1.5 h-1.5 rounded-full ${dotClass}`;
        els.statusText.textContent = text;
        els.statusText.className = `text-[10px] font-semibold ${textClass}`;
    }
    function updateUI() {
        if (state.activeTab !== 'overview')
            return;
        const loop = state.bridgeState?.loop || {};
        const phase = loop.phase || 'IDLE';
        const running = loop.running || phase !== 'IDLE';
        const uptime = loop.uptimeSec || 0;
        const cfg = getPhaseConfig(phase);
        els.phaseBadge.className = `text-[10px] font-bold px-2 py-0.5 rounded-lg border ${cfg.cls}`;
        els.phaseBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${cfg.pulse} inline-block mr-1.5 align-middle"></span>${cfg.label}`;
        if (running) {
            startUptimeCounter(uptime);
            setStatusBadge('bg-success pulse-dot', 'Running', 'text-success');
            els.heartbeat.className = 'flex items-center gap-1.5 text-success';
            els.heartbeat.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-success pulse-dot"></span>Active';
            els.projectLabel.textContent = `Project: ${loop.project || '—'}`;
        }
        else {
            stopUptimeCounter();
            els.uptime.textContent = '—';
            setStatusBadge('bg-zinc-600', 'Offline', 'text-zinc-500');
            els.heartbeat.className = 'flex items-center gap-1.5 text-zinc-500';
            els.heartbeat.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>Inactive';
            els.projectLabel.textContent = 'Project: —';
        }
        updateLoopActions();
    }
    function renderProcesses() {
        const procs = [
            {
                id: 'omniroute',
                name: 'OmniRoute Gateway',
                desc: 'AI router & proxy',
                port: '20128',
                data: state.bridgeState?.omniroute || {},
            },
            {
                id: 'opencode',
                name: 'OpenCode Server',
                desc: 'IDE sandbox',
                port: '4096',
                data: state.bridgeState?.opencode || {},
            },
        ];
        const anyData = procs.some(p => p.data && (p.data.running !== undefined || p.data.status));
        if (!anyData) {
            els.processList.innerHTML = '';
            els.noProcMsg.classList.remove('hidden');
            return;
        }
        els.noProcMsg.classList.add('hidden');
        els.processList.innerHTML = procs.map(p => {
            const running = !!(p.data?.running || (p.data?.status === 'running'));
            const pid = p.data?.pid || null;
            return `
      <div class="proc-card flex items-center gap-3 p-3 bg-white/[0.01] border border-white/5 rounded-xl hover:border-white/10 transition-all duration-200" data-proc="${p.id}">
        <div class="mm-toggle ${running ? 'on' : ''}" data-proc="${p.id}" data-action="${running ? 'stop' : 'start'}" title="${running ? 'Click to stop' : 'Click to start'}"></div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <h4 class="text-xs font-semibold text-white">${p.name}</h4>
            <span class="flex items-center gap-1 text-[9px] font-bold ${running ? 'text-success' : 'text-zinc-500'}">
              <span class="w-1 h-1 rounded-full ${running ? 'bg-success pulse-dot' : 'bg-zinc-600'}"></span>
              ${running ? 'On' : 'Off'}
            </span>
          </div>
          <p class="text-[10px] text-zinc-500 mt-0.5 truncate">${p.desc} (port ${p.port})${pid ? ` · PID: ${pid}` : ''}</p>
        </div>
        <div class="flex gap-1 shrink-0">
          ${running
                ? `<button data-proc="${p.id}" data-action="stop" class="proc-btn text-[9px] font-bold px-2 py-1.5 rounded-lg bg-danger/10 hover:bg-danger/20 text-danger border border-danger/15 transition outline-none">Stop</button>
               <button data-proc="${p.id}" data-action="restart" class="proc-btn text-[9px] font-bold px-2 py-1.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 border border-zinc-700/30 transition outline-none">Restart</button>`
                : `<button data-proc="${p.id}" data-action="start" class="proc-btn text-[9px] font-bold px-2 py-1.5 rounded-lg bg-success/10 hover:bg-success/20 text-success border border-success/15 transition outline-none">Start</button>`}
        </div>
      </div>`;
        }).join('');
        els.processList.querySelectorAll('.proc-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                const procId = e.currentTarget.dataset.proc;
                const action = e.currentTarget.dataset.action;
                executeProcessCmd(procId, action, e.currentTarget);
            });
        });
        els.processList.querySelectorAll('.mm-toggle').forEach(toggle => {
            toggle.addEventListener('click', e => {
                const procId = e.currentTarget.dataset.proc;
                const action = e.currentTarget.dataset.action;
                const btn = document.createElement('button');
                btn.innerHTML = action === 'stop' ? 'Stop' : 'Start';
                executeProcessCmd(procId, action, btn).then(() => {
                    e.currentTarget.classList.toggle('on');
                    e.currentTarget.dataset.action = action === 'stop' ? 'start' : 'stop';
                    e.currentTarget.title = action === 'stop' ? 'Click to start' : 'Click to stop';
                });
            });
        });
    }
    function fetchProjects() {
        if (_projectFetchAttempted)
            return;
        _projectFetchAttempted = true;
        api.get('/projects').then(list => {
            if (Array.isArray(list) && list.length > 0) {
                _projects = list;
            }
        }).catch(() => { });
    }
    function showProjectSuggestions(filter) {
        const list = els.projectSuggestions;
        if (!filter || _projects.length === 0) {
            list.classList.add('hidden');
            return;
        }
        const f = filter.toLowerCase();
        const matches = _projects.filter(p => p.key.toLowerCase().includes(f) || p.desc.toLowerCase().includes(f));
        if (matches.length === 0) {
            list.classList.add('hidden');
            return;
        }
        list.innerHTML = matches.map(p => `<div class="project-suggestion px-3 py-2 text-xs text-zinc-300 hover:bg-primary/10 hover:text-white cursor-pointer border-b border-white/[0.02] last:border-b-0 transition flex items-center gap-2" data-key="${p.key}">
        <span class="w-1.5 h-1.5 rounded-full bg-primary/60"></span>
        <span class="font-medium">${p.key}</span>
        <span class="text-zinc-600 ml-auto text-[10px] truncate max-w-[120px]">${p.desc}</span>
      </div>`).join('');
        list.classList.remove('hidden');
        list.querySelectorAll('.project-suggestion').forEach(el => {
            el.addEventListener('click', () => {
                els.cmdProjectInput.value = el.dataset.key;
                els.cmdStart.disabled = false;
                list.classList.add('hidden');
            });
        });
    }
    els.cmdProjectInput.addEventListener('input', () => {
        const v = els.cmdProjectInput.value.trim();
        els.cmdStart.disabled = false;
        showProjectSuggestions(v);
    });
    els.cmdProjectInput.addEventListener('focus', () => {
        const v = els.cmdProjectInput.value.trim();
        if (v)
            showProjectSuggestions(v);
        else if (_projects.length > 0)
            showProjectSuggestions('');
    });
    document.addEventListener('click', e => {
        if (!els.projectSuggestions.contains(e.target) && e.target !== els.cmdProjectInput) {
            els.projectSuggestions.classList.add('hidden');
        }
    });
    els.cmdProjectInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !els.cmdStart.disabled) {
            els.cmdStart.click();
        }
        if (e.key === 'Escape')
            els.projectSuggestions.classList.add('hidden');
    });
    els.cmdPause.addEventListener('click', () => {
        _isPaused = true;
        executeCommand('pause', els.cmdPause);
    });
    els.cmdResume.addEventListener('click', () => {
        _isPaused = false;
        executeCommand('resume', els.cmdResume);
    });
    els.cmdStop.addEventListener('click', () => {
        if (_stopConfirm) {
            _stopConfirm = false;
            stopUptimeCounter();
            executeCommand('kill', els.cmdStop);
        }
        else {
            setStopBtnArmed(true);
        }
    });
    els.cmdStart.addEventListener('click', () => {
        const projectKey = els.cmdProjectInput.value.trim() || undefined;
        executeCommand('start', els.cmdStart, projectKey ? { projectKey } : {});
    });
    async function execBulk(action) {
        const procs = ['omniroute', 'opencode'];
        const results = await Promise.allSettled(procs.map(name => {
            const pData = state.bridgeState?.[name] || {};
            const running = !!(pData.running || pData.status === 'running');
            const skip = action === 'stop' ? !running : !running;
            if (skip)
                return Promise.resolve();
            return api.post('/process-cmd', { processName: name, action });
        }));
        const ok = results.filter(r => r.status === 'fulfilled').length;
        if (ok > 0) {
            setTimeout(() => state.notify(), 500);
        }
    }
    els.procStopAll.addEventListener('click', () => {
        execBulk('stop');
    });
    els.procRestartAll.addEventListener('click', () => {
        execBulk('restart');
    });
    fetchProjects();
    state.subscribe(() => {
        if (state.activeTab !== 'overview')
            return;
        updateUI();
        renderProcesses();
    });
    updateUI();
    renderProcesses();
}
