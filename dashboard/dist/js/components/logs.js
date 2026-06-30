/* global navigator */
import { escapeHtml } from '../utils/sanitize.js';
import { formatDate } from '../utils/format.js';
const SOURCE_COLORS = {
    opencode: 'text-sky-400',
    'model-router': 'text-emerald-400',
    telegram: 'text-violet-400',
    dashboard: 'text-amber-400',
    orchestrator: 'text-rose-400',
    agent: 'text-cyan-400',
    bridge: 'text-blue-400',
    quota: 'text-teal-400',
};
function sourceColor(source) {
    return SOURCE_COLORS[source] || 'text-zinc-400';
}
export function mountLogs(container, state, api = null) {
    let filterLevel = 'all';
    let filterSource = 'all';
    let searchQuery = '';
    let isPaused = false;
    let autoscrollEnabled = true;
    const displayedLogIds = new Set();
    // Render layout structure once
    container.innerHTML = `
    <div class="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-4">
      <div>
        <h3 class="font-bold text-base text-zinc-100">System Logs</h3>
        <p class="text-xs text-zinc-400 mt-0.5">Real-time consolidated subprocess stdout/stderr feed</p>
      </div>
      <div class="flex flex-wrap items-center gap-2 w-full lg:w-auto">
        <!-- Search -->
        <input id="log-search" type="text" placeholder="Search logs..." class="bg-zinc-800 border border-zinc-700 text-xs rounded px-3 py-1.5 outline-none focus:border-primary text-zinc-200 placeholder-zinc-500 w-full sm:w-40" />

        <!-- Source Filter -->
        <select id="log-source-filter" class="bg-zinc-800 border border-zinc-700 text-xs rounded px-3 py-1.5 outline-none focus:border-primary text-zinc-200">
          <option value="all">All Sources</option>
          <option value="orchestrator">Orchestrator</option>
          <option value="agent">Agent Runtime</option>
          <option value="model-router">Model Router</option>
          <option value="opencode">OpenCode Serve</option>
          <option value="telegram">Telegram Bot</option>
          <option value="dashboard">Dashboard</option>
          <option value="quota">Quota Manager</option>
        </select>

        <!-- Level Filter -->
        <select id="log-level-filter" class="bg-zinc-800 border border-zinc-700 text-xs rounded px-3 py-1.5 outline-none focus:border-primary text-zinc-200">
          <option value="all">All Levels</option>
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
          <option value="debug">Debug</option>
        </select>

        <!-- Pause Streaming Button -->
        <button id="log-pause-btn" class="px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-xs font-semibold transition text-zinc-200 outline-none flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
          <span>Pause Stream</span>
        </button>

        <!-- Copy Logs -->
        <button id="log-copy-btn" class="px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-xs font-semibold transition text-zinc-200 outline-none">
          Copy
        </button>

        <!-- Clear Logs -->
        <button id="log-clear-btn" class="px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-xs font-semibold transition text-zinc-200 outline-none">
          Clear View
        </button>
      </div>
    </div>
    
    <!-- Logs feed area container -->
    <div class="relative">
      <div class="h-[450px] overflow-y-auto custom-scrollbar p-3 bg-zinc-950/60 border border-white/5 rounded-lg space-y-1.5 code-font text-xs" id="log-scroll">
        <!-- Logs dynamically appended here -->
      </div>
      
      <!-- Autoscroll overlay resume button -->
      <button id="log-autoscroll-btn" class="hidden absolute bottom-4 right-6 bg-primary hover:bg-primary/80 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg font-semibold transition border border-white/10 outline-none flex items-center gap-1.5 animate-bounce z-20">
        <span>⬇ Resume Auto-Scroll</span>
      </button>
    </div>
  `;
    const logScroll = container.querySelector('#log-scroll');
    const searchInput = container.querySelector('#log-search');
    const sourceSelect = container.querySelector('#log-source-filter');
    const levelSelect = container.querySelector('#log-level-filter');
    const pauseBtn = container.querySelector('#log-pause-btn');
    const copyBtn = container.querySelector('#log-copy-btn');
    const clearBtn = container.querySelector('#log-clear-btn');
    const autoscrollBtn = container.querySelector('#log-autoscroll-btn');
    // Register listeners once
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase().trim();
        rebuildLogs();
    });
    sourceSelect.addEventListener('change', (e) => {
        filterSource = e.target.value;
        rebuildLogs();
    });
    levelSelect.addEventListener('change', (e) => {
        filterLevel = e.target.value;
        rebuildLogs();
    });
    pauseBtn.addEventListener('click', () => {
        isPaused = !isPaused;
        if (isPaused) {
            pauseBtn.innerHTML = `
        <span class="w-1.5 h-1.5 rounded-full bg-danger"></span>
        <span>Resume Stream</span>
      `;
        }
        else {
            pauseBtn.innerHTML = `
        <span class="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
        <span>Pause Stream</span>
      `;
            rebuildLogs();
        }
    });
    let activeDomElements = [];
    let lastProcessedLogId = null;
    copyBtn.addEventListener('click', () => {
        const lines = activeDomElements.map((el) => {
            const time = el.querySelector('span:first-child')?.textContent || '';
            const source = el.querySelector('span:nth-child(2)')?.textContent || '';
            const msg = el.querySelector('span:nth-child(3)')?.textContent || '';
            return `${time} ${source} ${msg}`;
        });
        const text = lines.join('\n');
        navigator.clipboard
            .writeText(text)
            .then(() => {
            const orig = copyBtn.textContent;
            copyBtn.textContent = 'Copied!';
            setTimeout(() => {
                copyBtn.textContent = orig;
            }, 1500);
        })
            .catch(() => {
            const orig = copyBtn.textContent;
            copyBtn.textContent = 'Failed';
            setTimeout(() => {
                copyBtn.textContent = orig;
            }, 1500);
        });
    });
    clearBtn.addEventListener('click', async () => {
        if (api) {
            clearBtn.textContent = 'Clearing...';
            clearBtn.disabled = true;
            try {
                await api.delete('/logs');
            }
            catch { /* ignore */ }
            clearBtn.textContent = 'Clear View';
            clearBtn.disabled = false;
        }
        state.clearLogs();
        displayedLogIds.clear();
        activeDomElements = [];
        lastProcessedLogId = null;
        logScroll.innerHTML =
            '<div class="text-center text-zinc-600 py-12 text-sm select-none">No logs matching filters</div>';
        autoscrollEnabled = true;
        autoscrollBtn.classList.add('hidden');
    });
    logScroll.addEventListener('scroll', () => {
        const threshold = 15;
        const isAtBottom = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight <= threshold;
        autoscrollEnabled = isAtBottom;
        if (isAtBottom) {
            autoscrollBtn.classList.add('hidden');
        }
        else {
            autoscrollBtn.classList.remove('hidden');
        }
    });
    autoscrollBtn.addEventListener('click', () => {
        autoscrollEnabled = true;
        logScroll.scrollTop = logScroll.scrollHeight;
        autoscrollBtn.classList.add('hidden');
    });
    const createLogElement = (log) => {
        let colorClass = 'text-zinc-300';
        if (log.level === 'error')
            colorClass = 'text-danger font-medium';
        else if (log.level === 'warn')
            colorClass = 'text-warning';
        else if (log.level === 'debug')
            colorClass = 'text-zinc-500';
        let messageHTML = escapeHtml(log.message);
        if (searchQuery) {
            const regex = new RegExp(`(${searchQuery.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi');
            messageHTML = messageHTML.replace(regex, '<mark class="bg-primary/40 text-white rounded px-0.5">$1</mark>');
        }
        const div = document.createElement('div');
        div.className = 'log-entry flex items-start gap-3 py-0.5 px-1 rounded transition duration-150';
        div.dataset.id = log.id;
        div.innerHTML = `
      <span class="text-zinc-600 shrink-0 select-none">${formatDate(log.ts).substring(11, 19)}</span>
      <span class="font-bold shrink-0 w-24 select-none ${sourceColor(log.source)}">[${escapeHtml(log.source)}]</span>
      <span class="break-all whitespace-pre-wrap ${colorClass}">${messageHTML}</span>
    `;
        return div;
    };
    const matchesFilters = (log) => {
        if (filterLevel !== 'all' && log.level !== filterLevel)
            return false;
        if (filterSource !== 'all' && log.source !== filterSource)
            return false;
        if (searchQuery &&
            !log.message.toLowerCase().includes(searchQuery) &&
            !log.source.toLowerCase().includes(searchQuery))
            return false;
        return true;
    };
    const rebuildLogs = () => {
        if (state.activeTab !== 'logs')
            return;
        displayedLogIds.clear();
        activeDomElements = [];
        const filteredLogs = [...state.logs].reverse().filter(matchesFilters);
        logScroll.innerHTML = '';
        if (filteredLogs.length === 0) {
            logScroll.innerHTML =
                '<div class="text-center text-zinc-600 py-12 text-sm select-none">No logs matching filters</div>';
            autoscrollBtn.classList.add('hidden');
        }
        else {
            const fragment = document.createDocumentFragment();
            for (const log of filteredLogs) {
                displayedLogIds.add(log.id);
                const el = createLogElement(log);
                fragment.appendChild(el);
                activeDomElements.push(el);
            }
            logScroll.appendChild(fragment);
            if (autoscrollEnabled) {
                logScroll.scrollTop = logScroll.scrollHeight;
                autoscrollBtn.classList.add('hidden');
            }
            else {
                autoscrollBtn.classList.remove('hidden');
            }
        }
    };
    state.subscribe((s) => {
        if (s.activeTab !== 'logs')
            return;
        if (isPaused)
            return;
        const newestLog = s.logs[0];
        if (newestLog && newestLog.id === lastProcessedLogId) {
            return;
        }
        const prevLastProcessedLogId = lastProcessedLogId;
        if (newestLog) {
            lastProcessedLogId = newestLog.id;
        }
        else {
            lastProcessedLogId = null;
        }
        let newLogs;
        if (prevLastProcessedLogId) {
            const idx = s.logs.findIndex((log) => log.id === prevLastProcessedLogId);
            if (idx !== -1) {
                newLogs = s.logs.slice(0, idx).reverse();
            }
            else {
                rebuildLogs();
                return;
            }
        }
        else {
            rebuildLogs();
            return;
        }
        if (newLogs.length === 0)
            return;
        let hasNewLog = false;
        const fragment = document.createDocumentFragment();
        for (const log of newLogs) {
            if (displayedLogIds.has(log.id))
                continue;
            displayedLogIds.add(log.id);
            if (matchesFilters(log)) {
                if (activeDomElements.length === 0 && logScroll.querySelector('.text-zinc-600')) {
                    logScroll.innerHTML = '';
                }
                const el = createLogElement(log);
                fragment.appendChild(el);
                activeDomElements.push(el);
                hasNewLog = true;
            }
        }
        if (hasNewLog) {
            logScroll.appendChild(fragment);
        }
        if (activeDomElements.length > 500) {
            const toRemoveCount = activeDomElements.length - 500;
            const toRemove = activeDomElements.splice(0, toRemoveCount);
            for (const el of toRemove) {
                displayedLogIds.delete(el.dataset.id);
                el.remove();
            }
        }
        if (hasNewLog) {
            if (autoscrollEnabled) {
                logScroll.scrollTop = logScroll.scrollHeight;
                autoscrollBtn.classList.add('hidden');
            }
            else {
                autoscrollBtn.classList.remove('hidden');
            }
        }
    });
    rebuildLogs();
}
