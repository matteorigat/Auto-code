const RANGE_OPTIONS = [
    { label: '1m', value: '1m', seconds: 60 },
    { label: '10m', value: '10m', seconds: 600 },
    { label: '1h', value: '1h', seconds: 3600 },
    { label: '1d', value: '1d', seconds: 86400 },
    { label: '24h', value: '24h', seconds: 86400 },
    { label: '1w', value: '1w', seconds: 604800 },
    { label: '1mo', value: '1mo', seconds: 2592000 },
];
function getBarColor(pct) {
    if (pct === null || pct === undefined)
        return '#52525b';
    if (pct < 50)
        return '#10b981';
    if (pct < 80)
        return '#f59e0b';
    return '#f43f5e';
}
function getBarGlow(color) {
    const map = { '#10b981': 'rgba(16,185,129,0.3)', '#f59e0b': 'rgba(245,158,11,0.3)', '#f43f5e': 'rgba(244,63,94,0.3)', '#52525b': 'rgba(82,82,91,0.2)' };
    return map[color] || 'rgba(139,92,246,0.3)';
}
function formatBytes(bytes) {
    if (!bytes || bytes === 0)
        return '0.0';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}
function formatUptime(seconds) {
    if (!seconds)
        return '';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}
function buildSparkPath(values, w, h) {
    if (!values || values.length < 2)
        return '';
    const pad = 2;
    const hh = h - pad * 2;
    const pts = values.map((v, i) => {
        const x = (i / (values.length - 1)) * w;
        const y = pad + hh - (v / 100) * hh;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M${pts.join(' L')}`;
}
let cpuHistory = [];
export function mountHeader(container, state, api, onRefresh, onRangeChange) {
    cpuHistory = [];
    container.innerHTML = `
    <div class="flex flex-col gap-3">
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div class="flex-shrink-0">
          <h1 class="text-2xl font-bold gradient-text tracking-tight flex items-center gap-2">
            <svg class="w-6 h-6 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 4"/><circle cx="12" cy="12" r="11" stroke-dasharray="1 6"/>
            </svg>
            Oracle Control Center
          </h1>
          <p class="text-xs text-zinc-500 mt-0.5 tracking-wide">Autonomous Agent Fleet Monitoring & Loop Orchestration</p>
        </div>
        <div class="flex flex-wrap items-center gap-2.5">
          <!-- System metrics cards -->
          <div class="flex items-stretch gap-2.5 border-r border-white/5 pr-3 mr-0.5 hidden sm:flex">
            <!-- CPU -->
            <div class="sys-stat">
              <div class="flex items-center gap-2.5">
                <div class="flex flex-col min-w-[90px]">
                  <div class="flex items-center justify-between mb-0.5">
                    <span class="text-[9px] text-zinc-500 uppercase tracking-widest font-semibold">CPU</span>
                    <span id="header-cpu" class="text-xs font-mono font-bold tabular-nums text-zinc-200">--%</span>
                  </div>
                  <div class="h-[5px] bg-zinc-800/70 rounded-full overflow-hidden shadow-inner">
                    <div id="header-cpu-bar" class="h-full rounded-full transition-all duration-500 ease-out" style="width:0%"></div>
                  </div>
                  <div class="flex items-center justify-between mt-0.5">
                    <span id="header-cpu-detail" class="text-[9px] text-zinc-600">--</span>
                    <svg id="header-cpu-spark" class="w-9 h-4" viewBox="0 0 50 24" preserveAspectRatio="none">
                      <path id="header-cpu-spark-path" d="" fill="none" stroke-width="1.5" class="sparkline-path" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
            <!-- RAM -->
            <div class="sys-stat">
              <div class="flex flex-col min-w-[100px]">
                <div class="flex items-center justify-between mb-0.5">
                  <span class="text-[9px] text-zinc-500 uppercase tracking-widest font-semibold">RAM</span>
                  <span id="header-ram" class="text-xs font-mono font-bold tabular-nums text-zinc-200">--%</span>
                </div>
                <div class="h-[5px] bg-zinc-800/70 rounded-full overflow-hidden shadow-inner">
                  <div id="header-ram-bar" class="h-full rounded-full transition-all duration-500 ease-out" style="width:0%"></div>
                </div>
                <span id="header-ram-detail" class="text-[9px] text-zinc-600 mt-0.5">--</span>
              </div>
            </div>
            <!-- DISK -->
            <div class="sys-stat">
              <div class="flex flex-col min-w-[100px]">
                <div class="flex items-center justify-between mb-0.5">
                  <span class="text-[9px] text-zinc-500 uppercase tracking-widest font-semibold">DISK</span>
                  <span id="header-disk" class="text-xs font-mono font-bold tabular-nums text-zinc-200">--%</span>
                </div>
                <div class="h-[5px] bg-zinc-800/70 rounded-full overflow-hidden shadow-inner">
                  <div id="header-disk-bar" class="h-full rounded-full transition-all duration-500 ease-out" style="width:0%"></div>
                </div>
                <span id="header-disk-detail" class="text-[9px] text-zinc-600 mt-0.5">--</span>
              </div>
            </div>
            <!-- Uptime -->
            <div class="sys-stat flex items-center pl-1">
              <div class="flex flex-col">
                <span class="text-[9px] text-zinc-500 uppercase tracking-widest font-semibold">UP</span>
                <span id="header-uptime" class="text-xs font-mono tabular-nums text-zinc-400 mt-0.5">--</span>
              </div>
            </div>
          </div>

          <!-- WS Indicator -->
          <div id="ws-indicator" class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-danger/10 border border-danger/20 text-danger transition-all duration-300" title="WebSocket Status">
            <div id="ws-indicator-dot" class="w-1.5 h-1.5 rounded-full bg-danger"></div>
            <span id="ws-indicator-text" class="text-[10px] font-semibold tracking-wide">WS</span>
          </div>

          <!-- Bridge Indicator -->
          <div id="bridge-indicator" class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-800/60 border border-zinc-700/50 text-zinc-500 transition-all duration-300" title="Core Bridge Health">
            <div id="bridge-indicator-dot" class="w-1.5 h-1.5 rounded-full bg-zinc-500"></div>
            <span id="bridge-indicator-text" class="text-[10px] font-semibold tracking-wide">Bridge</span>
          </div>

          <button id="refresh-btn" class="px-3 py-1 rounded-lg bg-white/5 hover:bg-white/10 active:bg-white/[0.06] transition-all text-[11px] font-medium border border-white/10 outline-none text-zinc-400 hover:text-zinc-300">
            Refresh
          </button>
        </div>
      </div>
      <div class="flex items-center gap-2 border-t border-white/[0.03] pt-2.5">
        <span class="text-[9px] text-zinc-600 uppercase tracking-widest font-semibold">Range</span>
        <div id="time-range-group" class="flex items-center gap-1">
          ${RANGE_OPTIONS.map((r) => `
            <button class="range-btn px-2.5 py-1 rounded-md text-[11px] font-medium border transition-all duration-150 outline-none ${r.value === '1d' ? 'bg-primary/15 border-primary/30 text-white' : 'bg-white/[0.03] border-white/[0.06] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-400'}" data-range="${r.value}">
              ${r.label}
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  `;
    // Inject component styles
    if (!document.getElementById('header-component-styles')) {
        const s = document.createElement('style');
        s.id = 'header-component-styles';
        s.textContent = `
      .sparkline-path { stroke: #8b5cf6; transition: d 0.5s ease; }
      .sys-stat .progress-fill { transition: width 0.7s ease-out, background 0.5s ease; }
      @keyframes bar-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.85; } }
      .sys-stat .bar-live { animation: bar-pulse 2s ease-in-out infinite; }
    `;
        document.head.appendChild(s);
    }
    const cpuEl = container.querySelector('#header-cpu');
    const ramEl = container.querySelector('#header-ram');
    const diskEl = container.querySelector('#header-disk');
    const cpuBar = container.querySelector('#header-cpu-bar');
    const ramBar = container.querySelector('#header-ram-bar');
    const diskBar = container.querySelector('#header-disk-bar');
    const cpuDetail = container.querySelector('#header-cpu-detail');
    const ramDetail = container.querySelector('#header-ram-detail');
    const diskDetail = container.querySelector('#header-disk-detail');
    const uptimeEl = container.querySelector('#header-uptime');
    const sparkPath = container.querySelector('#header-cpu-spark-path');
    const wsIndicator = container.querySelector('#ws-indicator');
    const wsDot = container.querySelector('#ws-indicator-dot');
    const wsText = container.querySelector('#ws-indicator-text');
    const bridgeIndicator = container.querySelector('#bridge-indicator');
    const bridgeDot = container.querySelector('#bridge-indicator-dot');
    const bridgeText = container.querySelector('#bridge-indicator-text');
    container.querySelector('#refresh-btn').addEventListener('click', onRefresh);
    let currentRange = '1d';
    const rangeGroup = container.querySelector('#time-range-group');
    rangeGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.range-btn');
        if (!btn)
            return;
        const range = btn.dataset.range;
        if (range === currentRange)
            return;
        currentRange = range;
        rangeGroup.querySelectorAll('.range-btn').forEach((b) => {
            if (b === btn) {
                b.className =
                    'range-btn px-2.5 py-1 rounded-md text-[11px] font-medium border transition-all duration-150 outline-none bg-primary/15 border-primary/30 text-white';
            }
            else {
                b.className =
                    'range-btn px-2.5 py-1 rounded-md text-[11px] font-medium border transition-all duration-150 outline-none bg-white/[0.03] border-white/[0.06] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-400';
            }
        });
        state.timeRange = range;
        if (onRangeChange)
            onRangeChange(range);
    });
    let isWsConnected = false;
    const updateIndicators = (s) => {
        const { systemMetrics } = s;
        if (systemMetrics) {
            const cpuVal = systemMetrics.cpu !== undefined
                ? systemMetrics.cpu
                : systemMetrics.cpu_pct !== undefined
                    ? systemMetrics.cpu_pct
                    : null;
            const ramVal = systemMetrics.ramPct !== undefined
                ? systemMetrics.ramPct
                : systemMetrics.ram_pct !== undefined
                    ? systemMetrics.ram_pct
                    : null;
            const diskVal = systemMetrics.diskPct !== undefined
                ? systemMetrics.diskPct
                : systemMetrics.disk_pct !== undefined
                    ? systemMetrics.disk_pct
                    : null;
            // CPU
            if (cpuVal !== null) {
                const color = getBarColor(cpuVal);
                cpuEl.textContent = `${cpuVal}%`;
                cpuBar.style.width = `${Math.min(cpuVal, 100)}%`;
                cpuBar.style.background = `linear-gradient(90deg, ${color}, ${color}dd)`;
                cpuBar.style.boxShadow = `0 0 8px ${getBarGlow(color)}`;
                const cores = systemMetrics.cpuCores || '';
                cpuDetail.textContent = cores ? `${cpuVal}% \u00B7 ${cores} cores` : `${cpuVal}%`;
                cpuHistory.push(cpuVal);
                if (cpuHistory.length > 30)
                    cpuHistory.shift();
                if (cpuHistory.length >= 2) {
                    sparkPath.setAttribute('d', buildSparkPath(cpuHistory, 50, 24));
                    sparkPath.setAttribute('stroke', color);
                }
            }
            else {
                cpuEl.textContent = '--%';
                cpuBar.style.width = '0%';
                cpuDetail.textContent = '--';
            }
            // RAM
            if (ramVal !== null) {
                const color = getBarColor(ramVal);
                ramEl.textContent = `${ramVal}%`;
                ramBar.style.width = `${Math.min(ramVal, 100)}%`;
                ramBar.style.background = `linear-gradient(90deg, ${color}, ${color}dd)`;
                ramBar.style.boxShadow = `0 0 8px ${getBarGlow(color)}`;
                const used = systemMetrics.ramUsed ? formatBytes(systemMetrics.ramUsed) : '--';
                const total = systemMetrics.ramTotal ? formatBytes(systemMetrics.ramTotal) : '--';
                ramDetail.textContent = `${used} / ${total} GB`;
            }
            else {
                ramEl.textContent = '--%';
                ramBar.style.width = '0%';
                ramDetail.textContent = '--';
            }
            // DISK
            if (diskVal !== null) {
                const color = getBarColor(diskVal);
                diskEl.textContent = `${diskVal}%`;
                diskBar.style.width = `${Math.min(diskVal, 100)}%`;
                diskBar.style.background = `linear-gradient(90deg, ${color}, ${color}dd)`;
                diskBar.style.boxShadow = `0 0 8px ${getBarGlow(color)}`;
                const used = systemMetrics.diskUsed ? `${systemMetrics.diskUsed}G` : '--';
                const total = systemMetrics.diskTotal ? `${systemMetrics.diskTotal}G` : '--';
                diskDetail.textContent = `${used} / ${total}`;
            }
            else {
                diskEl.textContent = '--%';
                diskBar.style.width = '0%';
                diskDetail.textContent = '--';
            }
            // Uptime
            uptimeEl.textContent = systemMetrics.uptime ? formatUptime(systemMetrics.uptime) : '--';
        }
        // WS Indicator
        if (isWsConnected) {
            wsIndicator.className =
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success/10 border border-success/20 text-success transition-all duration-300';
            wsDot.className = 'w-1.5 h-1.5 rounded-full bg-success pulse-dot';
            wsText.textContent = 'WS';
        }
        else {
            wsIndicator.className =
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-danger/10 border border-danger/20 text-danger transition-all duration-300';
            wsDot.className = 'w-1.5 h-1.5 rounded-full bg-danger';
            wsText.textContent = 'WS';
        }
        // Bridge Indicator
        const processes = s.bridgeState;
        const isLoopRunning = processes?.loop?.running || (processes?.loop?.phase && processes.loop.phase !== 'IDLE');
        const isOpencodeRunning = processes?.opencode?.running;
        const isModelRouterRunning = processes?.['model-router']?.running;
        const isBridgeOnline = isOpencodeRunning || isModelRouterRunning || isLoopRunning;
        if (isBridgeOnline) {
            bridgeIndicator.className =
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accentBlue/10 border border-accentBlue/20 text-accentBlue transition-all duration-300';
            bridgeDot.className = 'w-1.5 h-1.5 rounded-full bg-accentBlue pulse-dot';
            const mrUptime = s.summary?.['model-router']?.uptime;
            bridgeText.textContent = `Bridge${mrUptime ? ` \u00B7 ${Math.floor(mrUptime)}s` : ''}`;
        }
        else {
            bridgeIndicator.className =
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-800/60 border border-zinc-700/50 text-zinc-500 transition-all duration-300';
            bridgeDot.className = 'w-1.5 h-1.5 rounded-full bg-zinc-500';
            bridgeText.textContent = 'Bridge';
        }
    };
    state.subscribe((s) => updateIndicators(s));
    updateIndicators(state);
    return {
        setConnectionStatus: (status) => {
            isWsConnected = status;
            updateIndicators(state);
        },
    };
}
