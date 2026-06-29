import { escapeHtml } from '../utils/sanitize.js';

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
  if (pct < 50) return '#10b981';
  if (pct < 80) return '#f59e0b';
  return '#f43f5e';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0.0';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function formatUptime(seconds) {
  if (!seconds) return '';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function buildSparkPath(values, w, h) {
  if (!values || values.length < 2) return '';
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
        <div>
            <h1 class="text-2xl font-bold gradient-text tracking-tight flex items-center gap-2">
              <span>Oracle Control Center</span>
            </h1>
            <p class="text-xs text-zinc-400 mt-0.5">Autonomous Agent Fleet Monitoring & Loop Orchestration</p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
            <!-- System metrics with progress bars -->
            <div class="flex items-center gap-4 border-r border-white/5 pr-4 mr-1 hidden sm:flex">
              <!-- CPU -->
              <div class="sys-stat">
                <div class="flex items-center gap-2">
                  <div class="flex flex-col min-w-[80px]">
                    <div class="flex items-center justify-between">
                      <span class="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">CPU</span>
                      <span id="header-cpu" class="text-xs font-mono font-bold tabular-nums text-zinc-300">--%</span>
                    </div>
                    <div class="h-[3px] bg-zinc-800/60 rounded-full mt-1 overflow-hidden">
                      <div id="header-cpu-bar" class="h-full rounded-full transition-all duration-700 ease-out bar-glow" style="width:0%"></div>
                    </div>
                    <span id="header-cpu-detail" class="text-[9px] text-zinc-600 mt-[2px]">--</span>
                  </div>
                  <svg id="header-cpu-spark" class="w-10 h-6" viewBox="0 0 50 30" preserveAspectRatio="none">
                    <path id="header-cpu-spark-path" d="" fill="none" stroke-width="1.5" class="sparkline-path" />
                  </svg>
                </div>
              </div>
              <!-- RAM -->
              <div class="sys-stat">
                <div class="flex flex-col min-w-[90px]">
                  <div class="flex items-center justify-between">
                    <span class="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">RAM</span>
                    <span id="header-ram" class="text-xs font-mono font-bold tabular-nums text-zinc-300">--%</span>
                  </div>
                    <div class="h-[3px] bg-zinc-800/60 rounded-full mt-1 overflow-hidden">
                      <div id="header-ram-bar" class="h-full rounded-full transition-all duration-700 ease-out bar-glow" style="width:0%"></div>
                    </div>
                    <span id="header-ram-detail" class="text-[9px] text-zinc-600 mt-[2px]">--</span>
                </div>
              </div>
              <!-- DISK -->
              <div class="sys-stat">
                <div class="flex flex-col min-w-[90px]">
                  <div class="flex items-center justify-between">
                    <span class="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">DISK</span>
                    <span id="header-disk" class="text-xs font-mono font-bold tabular-nums text-zinc-300">--%</span>
                  </div>
                    <div class="h-[3px] bg-zinc-800/60 rounded-full mt-1 overflow-hidden">
                      <div id="header-disk-bar" class="h-full rounded-full transition-all duration-700 ease-out bar-glow" style="width:0%"></div>
                    </div>
                    <span id="header-disk-detail" class="text-[9px] text-zinc-600 mt-[2px]">--</span>
                </div>
              </div>
              <!-- Uptime -->
              <div class="sys-stat min-w-[60px]">
                <div class="flex flex-col">
                  <span class="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">UP</span>
                  <span id="header-uptime" class="text-xs font-mono tabular-nums text-zinc-500 mt-[2px]">--</span>
                </div>
              </div>
            </div>
            
            <!-- WS Connection Indicator -->
            <div id="ws-indicator" class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-danger/10 border border-danger/20 text-danger transition-all duration-300" title="WebSocket Status">
                <div id="ws-indicator-dot" class="w-2 h-2 rounded-full bg-danger"></div>
                <span id="ws-indicator-text" class="text-xs font-semibold">WS Off</span>
            </div>

            <!-- Bridge Liveness Indicator -->
            <div id="bridge-indicator" class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-400 transition-all duration-300" title="Core Bridge Health">
                <div id="bridge-indicator-dot" class="w-2 h-2 rounded-full bg-zinc-500"></div>
                <span id="bridge-indicator-text" class="text-xs font-semibold">Bridge ?</span>
            </div>

            <button id="refresh-btn" class="px-4 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition text-xs font-medium border border-white/10 outline-none">
                Refresh
            </button>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mr-1">Range</span>
        <div id="time-range-group" class="flex items-center gap-1">
          ${RANGE_OPTIONS.map(
            (r) => `
            <button class="range-btn px-3 py-1 rounded-md text-xs font-medium border transition-all duration-150 outline-none ${r.value === '1d' ? 'bg-primary/20 border-primary/40 text-white' : 'bg-white/5 border-white/10 text-zinc-400 hover:bg-white/10 hover:text-zinc-300'}" data-range="${r.value}">
              ${r.label}
            </button>
          `,
          ).join('')}
        </div>
      </div>
    </div>
  `;

  // Inject component styles
  if (!document.getElementById('header-component-styles')) {
    const s = document.createElement('style');
    s.id = 'header-component-styles';
    s.textContent = `
      .sparkline-path {
        stroke: #8b5cf6;
        transition: d 0.5s ease;
      }
      .sys-stat .progress-fill {
        transition: width 0.7s ease-out, background 0.5s ease;
      }
      @keyframes bar-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.85; }
      }
      .sys-stat .bar-live {
        animation: bar-pulse 2s ease-in-out infinite;
      }
      @keyframes glow-pulse {
        0%, 100% { box-shadow: 0 0 4px rgba(139, 92, 246, 0.15); }
        50% { box-shadow: 0 0 8px rgba(139, 92, 246, 0.3); }
      }
      .sys-stat .bar-glow {
        animation: glow-pulse 2s ease-in-out infinite;
      }
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
    if (!btn) return;
    const range = btn.dataset.range;
    if (range === currentRange) return;
    currentRange = range;
    rangeGroup.querySelectorAll('.range-btn').forEach((b) => {
      if (b === btn) {
        b.className =
          'range-btn px-3 py-1 rounded-md text-xs font-medium border transition-all duration-150 outline-none bg-primary/20 border-primary/40 text-white';
      } else {
        b.className =
          'range-btn px-3 py-1 rounded-md text-xs font-medium border transition-all duration-150 outline-none bg-white/5 border-white/10 text-zinc-400 hover:bg-white/10 hover:text-zinc-300';
      }
    });
    state.timeRange = range;
    if (onRangeChange) onRangeChange(range);
  });

  let isWsConnected = false;

  const updateIndicators = (state) => {
    const { systemMetrics } = state;
    if (systemMetrics) {
      const cpuVal =
        systemMetrics.cpu !== undefined
          ? systemMetrics.cpu
          : systemMetrics.cpu_pct !== undefined
            ? systemMetrics.cpu_pct
            : null;
      const ramVal =
        systemMetrics.ramPct !== undefined
          ? systemMetrics.ramPct
          : systemMetrics.ram_pct !== undefined
            ? systemMetrics.ram_pct
            : null;
      const diskVal =
        systemMetrics.diskPct !== undefined
          ? systemMetrics.diskPct
          : systemMetrics.disk_pct !== undefined
            ? systemMetrics.disk_pct
            : null;

      // CPU
      if (cpuVal !== null) {
        const cpuText = `${cpuVal}%`;
        cpuEl.textContent = cpuText;
        cpuBar.style.width = `${cpuVal}%`;
        cpuBar.style.background = `linear-gradient(90deg, ${getBarColor(cpuVal)}, ${getBarColor(Math.min(cpuVal + 10, 100))})`;
        const cores = systemMetrics.cpuCores || '';
        cpuDetail.textContent = cores ? `${cpuVal}% · ${cores} cores` : `${cpuVal}%`;

        // Sparkline
        cpuHistory.push(cpuVal);
        if (cpuHistory.length > 30) cpuHistory.shift();
        if (cpuHistory.length >= 2) {
          sparkPath.setAttribute('d', buildSparkPath(cpuHistory, 50, 30));
          sparkPath.setAttribute('stroke', getBarColor(cpuVal));
        }
      }

      // RAM
      if (ramVal !== null) {
        ramEl.textContent = `${ramVal}%`;
        ramBar.style.width = `${ramVal}%`;
        ramBar.style.background = `linear-gradient(90deg, ${getBarColor(ramVal)}, ${getBarColor(Math.min(ramVal + 10, 100))})`;
        const used = systemMetrics.ramUsed ? formatBytes(systemMetrics.ramUsed) : '--';
        const total = systemMetrics.ramTotal ? formatBytes(systemMetrics.ramTotal) : '--';
        ramDetail.textContent = `${used} / ${total} GB`;
      }

      // DISK
      if (diskVal !== null) {
        diskEl.textContent = `${diskVal}%`;
        diskBar.style.width = `${diskVal}%`;
        diskBar.style.background = `linear-gradient(90deg, ${getBarColor(diskVal)}, ${getBarColor(Math.min(diskVal + 10, 100))})`;
        const used = systemMetrics.diskUsed ? `${systemMetrics.diskUsed}G` : '--';
        const total = systemMetrics.diskTotal ? `${systemMetrics.diskTotal}G` : '--';
        diskDetail.textContent = `${used} / ${total}`;
      }

      // Uptime
      uptimeEl.textContent = systemMetrics.uptime ? formatUptime(systemMetrics.uptime) : '--';
    }

    // WebSocket Indicator
    if (isWsConnected) {
      wsIndicator.className =
        'flex items-center gap-2 px-3 py-1.5 rounded-full bg-success/10 border border-success/20 text-success transition-all duration-300';
      wsDot.className = 'w-2 h-2 rounded-full bg-success pulse-dot';
      wsText.textContent = 'WS Live';
    } else {
      wsIndicator.className =
        'flex items-center gap-2 px-3 py-1.5 rounded-full bg-danger/10 border border-danger/20 text-danger transition-all duration-300';
      wsDot.className = 'w-2 h-2 rounded-full bg-danger';
      wsText.textContent = 'WS Off';
    }

    // Bridge Liveness Indicator
    const processes = state.bridgeState;
    const isLoopRunning =
      processes?.loop?.running || (processes?.loop?.phase && processes.loop.phase !== 'IDLE');
    const isOpencodeRunning = processes?.opencode?.running;
    const isOmniRouteRunning = processes?.omniroute?.running;
    const isBridgeOnline = isOpencodeRunning || isOmniRouteRunning || isLoopRunning;
    const hasOrHealth = !!(state.summary?.omniroute);

    if (isBridgeOnline) {
      bridgeIndicator.className =
        'flex items-center gap-2 px-3 py-1.5 rounded-full bg-accentBlue/10 border border-accentBlue/20 text-accentBlue transition-all duration-300';
      bridgeDot.className = 'w-2 h-2 rounded-full bg-accentBlue pulse-dot';
      const orUptime = state.summary?.omniroute?.uptime;
      const uptimeStr = orUptime ? `${Math.floor(orUptime)}s` : '';
      bridgeText.textContent = `Bridge On${uptimeStr ? ` · OR ${uptimeStr}` : ''}`;
    } else {
      bridgeIndicator.className =
        'flex items-center gap-2 px-3 py-1.5 rounded-full bg-danger/10 border border-danger/20 text-danger transition-all duration-300';
      bridgeDot.className = 'w-2 h-2 rounded-full bg-danger';
      bridgeText.textContent = `Bridge Off`;
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
