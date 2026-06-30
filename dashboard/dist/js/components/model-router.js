import { escapeHtml } from '../utils/sanitize.js';
function fmtMs(ms) {
    if (ms == null)
        return '—';
    return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function fmtPct(n) {
    if (n == null)
        return '—';
    return `${n.toFixed(1)}%`;
}
function fmtNum(n) {
    if (n == null)
        return '—';
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)
        return `${(n / 1_000).toFixed(1)}K`;
    return `${n}`;
}
function fmtTime(ts) {
    if (!ts)
        return '—';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function slotStatusBadge(slot) {
    const now = Date.now();
    const isCooldown = slot.cooldownRemainingMs > 0;
    const status = isCooldown ? 'cooldown' : slot.status;
    const colors = {
        active: 'bg-success/10 text-success border-success/20',
        cooldown: 'bg-warning/10 text-warning border-warning/20',
        'circuit-open': 'bg-danger/10 text-danger border-danger/20',
        disabled: 'bg-zinc-800/40 text-zinc-500 border-zinc-700/30',
    };
    const c = colors[status] || colors.disabled;
    const dot = status === 'active' ? 'bg-success' : status === 'cooldown' ? 'bg-warning' : 'bg-danger';
    const label = isCooldown ? `${(slot.cooldownRemainingMs / 1000).toFixed(0)}s` : status;
    return `<span class="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border ${c}"><span class="w-1.5 h-1.5 rounded-full ${dot}"></span>${escapeHtml(label)}</span>`;
}
function kpi(label, value, sub, color) {
    return `<div class="bg-white/[0.01] border border-white/5 rounded-xl p-4 hover:border-white/10 transition">
    <div class="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-1">${escapeHtml(label)}</div>
    <div class="text-lg font-bold ${color}">${escapeHtml(value)}</div>
    <div class="text-[10px] text-zinc-600 mt-0.5">${escapeHtml(sub)}</div>
  </div>`;
}
export function mountModelRouter(container, state, api) {
    container.innerHTML = `
    <!-- KPI row -->
    <div id="mr-kpis" class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3"></div>

    <!-- Accounts / Slots Grid -->
    <div class="glass-panel p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-sm font-semibold text-zinc-200">Account Slots</h3>
          <p class="text-[10px] text-zinc-500 mt-0.5">36 free + zen + openrouter</p>
        </div>
        <div class="flex items-center gap-3">
          <span id="mr-filter-btns" class="flex gap-1">
            <button data-filter="all" class="mr-filter-btn text-[10px] px-2 py-1 rounded bg-zinc-700/40 text-zinc-300 font-semibold">All</button>
            <button data-filter="opencode-free" class="mr-filter-btn text-[10px] px-2 py-1 rounded bg-zinc-800/40 text-zinc-500 hover:text-zinc-300">Free</button>
            <button data-filter="opencode-zen" class="mr-filter-btn text-[10px] px-2 py-1 rounded bg-zinc-800/40 text-zinc-500 hover:text-zinc-300">Zen</button>
            <button data-filter="openrouter" class="mr-filter-btn text-[10px] px-2 py-1 rounded bg-zinc-800/40 text-zinc-500 hover:text-zinc-300">OR</button>
          </span>
        </div>
      </div>
      <div id="mr-accounts-grid" class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
        <div class="text-zinc-600 text-xs py-8 text-center col-span-full">Loading accounts...</div>
      </div>
    </div>

    <!-- Two-column stats -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Per-Model Breakdown -->
      <div class="glass-panel p-5">
        <h3 class="text-sm font-semibold text-zinc-200 mb-4">Per-Model Breakdown</h3>
        <div id="mr-per-model" class="overflow-x-auto custom-scrollbar max-h-80 overflow-y-auto">
          <div class="text-zinc-600 text-xs py-4 text-center">Loading...</div>
        </div>
      </div>

      <!-- Recent Activity Log -->
      <div class="glass-panel p-5">
        <h3 class="text-sm font-semibold text-zinc-200 mb-4">Recent Activity</h3>
        <div id="mr-recent-log" class="overflow-x-auto custom-scrollbar max-h-80 overflow-y-auto">
          <div class="text-zinc-600 text-xs py-4 text-center">Loading...</div>
        </div>
      </div>
    </div>
  `;
    const kpisEl = container.querySelector('#mr-kpis');
    const gridEl = container.querySelector('#mr-accounts-grid');
    const perModelEl = container.querySelector('#mr-per-model');
    const recentLogEl = container.querySelector('#mr-recent-log');
    const filterBtns = container.querySelector('#mr-filter-btns');
    let activeFilter = 'all';
    filterBtns?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-filter]');
        if (!btn)
            return;
        activeFilter = btn.dataset.filter || 'all';
        filterBtns.querySelectorAll('.mr-filter-btn').forEach((b) => {
            b.classList.remove('bg-zinc-700/40', 'text-zinc-300');
            b.classList.add('bg-zinc-800/40', 'text-zinc-500');
        });
        btn.classList.remove('bg-zinc-800/40', 'text-zinc-500');
        btn.classList.add('bg-zinc-700/40', 'text-zinc-300');
        renderAccounts();
    });
    function renderKPIs() {
        const stats = state.modelRouterStats;
        if (!stats) {
            kpisEl.innerHTML = '<div class="text-zinc-500 text-xs py-4 text-center col-span-full col-span-6">Loading stats...</div>';
            return;
        }
        const activeAccounts = state.modelRouterAccounts?.accounts?.filter((a) => a.status === 'active' && !a.cooldownRemainingMs).length || 0;
        kpisEl.innerHTML =
            kpi('Total Requests', fmtNum(stats.totalRequests), `${fmtPct(stats.successRate)} success rate`, 'text-zinc-200') +
                kpi('Active Slots', String(activeAccounts), `out of ${state.modelRouterAccounts?.total || 0} total`, 'text-success') +
                kpi('5m Avg Latency', fmtMs(stats.recent5m?.avgLatencyMs), `${stats.recent5m?.requests || 0} requests in 5m`, stats.recent5m?.avgLatencyMs > 10000 ? 'text-warning' : 'text-zinc-200') +
                kpi('Total Failures', fmtNum(stats.totalFailures), `${fmtPct(stats.recent5m?.requests > 0 ? (stats.recent5m?.failures / stats.recent5m?.requests) * 100 : 0)} recent failure rate`, stats.totalFailures > 0 ? 'text-danger' : 'text-zinc-200') +
                kpi('Tokens In', fmtNum(stats.byTier?.['opencode-free']?.tokensIn || 0), `zen: ${fmtNum(stats.byTier?.['opencode-zen']?.tokensIn || 0)}`, 'text-accentBlue') +
                kpi('Tokens Out', fmtNum(stats.byTier?.['opencode-free']?.tokensOut || 0), `zen: ${fmtNum(stats.byTier?.['opencode-zen']?.tokensOut || 0)}`, 'text-primary');
    }
    function renderAccounts() {
        const data = state.modelRouterAccounts;
        if (!data || !data.accounts) {
            gridEl.innerHTML = '<div class="text-zinc-600 text-xs py-8 text-center col-span-full">Account data unavailable</div>';
            return;
        }
        const filtered = data.accounts.filter((a) => activeFilter === 'all' ? true : a.tier === activeFilter);
        if (!filtered.length) {
            gridEl.innerHTML = '<div class="text-zinc-600 text-xs py-8 text-center col-span-full">No accounts match filter</div>';
            return;
        }
        gridEl.innerHTML = filtered.map((a) => {
            const cooldown = a.cooldownRemainingMs > 0;
            const statusColor = a.status === 'active' && !cooldown
                ? 'border-success/20 bg-success/[0.02]'
                : a.status === 'circuit-open'
                    ? 'border-danger/20 bg-danger/[0.02]'
                    : cooldown
                        ? 'border-warning/20 bg-warning/[0.02]'
                        : 'border-zinc-700/30 bg-zinc-800/20';
            const dotColor = a.status === 'active' && !cooldown
                ? 'bg-success'
                : a.status === 'circuit-open'
                    ? 'bg-danger'
                    : cooldown
                        ? 'bg-warning'
                        : 'bg-zinc-500';
            const latencyColor = a.lastLatencyMs
                ? a.lastLatencyMs > 10000 ? 'text-danger' : a.lastLatencyMs > 5000 ? 'text-warning' : 'text-zinc-400'
                : 'text-zinc-600';
            return `<div class="rounded-lg border ${statusColor} p-2.5 hover:border-white/20 transition cursor-pointer group relative" data-slot-id="${escapeHtml(a.id)}">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[10px] font-semibold text-zinc-300 font-mono">${escapeHtml(a.id)}</span>
          <span class="w-2 h-2 rounded-full ${dotColor} ${cooldown ? 'animate-pulse' : ''}"></span>
        </div>
        <div class="text-[8px] text-zinc-500 font-mono space-y-0.5">
          <div class="flex items-center justify-between">
            <span>calls</span>
            <span class="text-zinc-400">${a.totalCalls || 0}</span>
          </div>
          <div class="flex items-center justify-between">
            <span>latency</span>
            <span class="${latencyColor}">${fmtMs(a.lastLatencyMs)}</span>
          </div>
          <div class="flex items-center justify-between">
            <span>in/out</span>
            <span class="text-zinc-400">${fmtNum(a.tokensIn)}/${fmtNum(a.tokensOut)}</span>
          </div>
          ${a.lastError ? `<div class="text-danger/70 truncate mt-0.5" title="${escapeHtml(a.lastError)}">✕ ${escapeHtml(a.lastError.slice(0, 40))}</div>` : ''}
        </div>
        <!-- Reset button (hidden, shown on hover) -->
        <button data-reset="${escapeHtml(a.id)}" class="mr-reset-btn hidden group-hover:block absolute top-1 right-1 text-[8px] px-1 py-0.5 rounded bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600 hover:text-white transition">↻</button>
      </div>`;
        }).join('');
        // Bind reset buttons
        gridEl.querySelectorAll('.mr-reset-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const slotId = btn.dataset.reset;
                if (!slotId)
                    return;
                try {
                    await api.post('/model-router/reset-slot', { slotId });
                }
                catch { /* ignore */ }
            });
        });
    }
    function renderPerModel() {
        const stats = state.modelRouterStats;
        if (!stats || !stats.perModel) {
            perModelEl.innerHTML = '<div class="text-zinc-600 text-xs py-4 text-center">No model data yet</div>';
            return;
        }
        const entries = Object.entries(stats.perModel);
        if (!entries.length) {
            perModelEl.innerHTML = '<div class="text-zinc-600 text-xs py-4 text-center">No model calls recorded</div>';
            return;
        }
        entries.sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0));
        perModelEl.innerHTML = `<table class="w-full text-left text-xs">
      <thead class="text-zinc-500 uppercase text-[9px]">
        <tr>
          <th class="px-2 py-2 sticky top-0 bg-zinc-900">Model</th>
          <th class="px-2 py-2 text-right sticky top-0 bg-zinc-900">Calls</th>
          <th class="px-2 py-2 text-right sticky top-0 bg-zinc-900">Failures</th>
          <th class="px-2 py-2 text-right sticky top-0 bg-zinc-900">Success</th>
          <th class="px-2 py-2 text-right sticky top-0 bg-zinc-900">Tokens In</th>
          <th class="px-2 py-2 text-right sticky top-0 bg-zinc-900">Tokens Out</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-white/5">${entries.map(([model, val]) => {
            const successRate = val.calls > 0 ? ((val.calls - (val.failures || 0)) / val.calls) * 100 : 100;
            const srColor = successRate >= 95 ? 'text-success' : successRate >= 80 ? 'text-warning' : 'text-danger';
            return `<tr class="hover:bg-white/[0.02]">
          <td class="px-2 py-1.5 font-mono text-zinc-200 text-[10px]">${escapeHtml(model)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${val.calls || 0}</td>
          <td class="px-2 py-1.5 text-right font-mono text-danger">${val.failures || 0}</td>
          <td class="px-2 py-1.5 text-right font-mono ${srColor}">${fmtPct(successRate)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtNum(val.tokensIn || 0)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtNum(val.tokensOut || 0)}</td>
        </tr>`;
        }).join('')}</tbody>
    </table>`;
    }
    function renderRecentLog() {
        const accounts = state.modelRouterAccounts?.accounts || [];
        const recentEntries = [...accounts]
            .filter((a) => a.lastCallAt)
            .sort((a, b) => (b.lastCallAt || 0) - (a.lastCallAt || 0))
            .slice(0, 30);
        if (!recentEntries.length) {
            recentLogEl.innerHTML = '<div class="text-zinc-600 text-xs py-4 text-center">No recent activity</div>';
            return;
        }
        recentLogEl.innerHTML = `<table class="w-full text-left text-xs">
      <thead class="text-zinc-500 uppercase text-[9px]">
        <tr>
          <th class="px-2 py-2 sticky top-0 bg-zinc-900">Time</th>
          <th class="px-2 py-2 sticky top-0 bg-zinc-900">Slot</th>
          <th class="px-2 py-2 sticky top-0 bg-zinc-900">Status</th>
          <th class="px-2 py-2 text-right sticky top-0 bg-zinc-900">Latency</th>
          <th class="px-2 py-2 text-right sticky top-0 bg-zinc-900">Tokens</th>
          <th class="px-2 py-2 text-right sticky top-0 bg-zinc-900">Error</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-white/5">${recentEntries.map((a) => {
            const hasError = !!a.lastError;
            return `<tr class="hover:bg-white/[0.02] ${hasError ? 'text-danger/70' : ''}">
          <td class="px-2 py-1.5 font-mono text-zinc-500 text-[10px]">${fmtTime(a.lastCallAt)}</td>
          <td class="px-2 py-1.5 font-mono text-zinc-300 text-[10px]">${escapeHtml(a.id)}</td>
          <td class="px-2 py-1.5 font-mono text-[10px] ${a.status === 'active' ? 'text-success' : 'text-warning'}">${a.status}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-400 text-[10px]">${fmtMs(a.lastLatencyMs)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-500 text-[10px]">${fmtNum((a.tokensIn || 0) + (a.tokensOut || 0))}</td>
          <td class="px-2 py-1.5 text-right font-mono text-danger/60 text-[10px] max-w-[100px] truncate" title="${escapeHtml(a.lastError || '')}">${hasError ? '✕' : '—'}</td>
        </tr>`;
        }).join('')}</tbody>
    </table>`;
    }
    const update = () => {
        if (state.activeTab !== 'model-router')
            return;
        renderKPIs();
        renderAccounts();
        renderPerModel();
        renderRecentLog();
    };
    state.subscribe(update);
    update();
}
