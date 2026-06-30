import { escapeHtml } from '../utils/sanitize.js';
function fmtMs(ms) {
    if (ms == null)
        return '—';
    return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function fmtPct(n) {
    return n != null ? `${n.toFixed(1)}%` : '—';
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
let _latencyChartInstance = null;
export function mountProviderStats(container, state) {
    container.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">
      <div class="lg:col-span-2 bg-white/[0.01] border border-white/5 rounded-xl p-4">
        <h4 class="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-3">Provider Performance</h4>
        <div id="provider-stats-table" class="overflow-x-auto custom-scrollbar"></div>
      </div>
      <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4">
        <h4 class="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-3">Latency Comparison</h4>
        <div class="h-64 relative"><canvas id="provider-latency-canvas"></canvas></div>
      </div>
    </div>
    <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4">
      <h4 class="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-3">Model-Level Breakdown</h4>
      <div id="provider-models-table" class="overflow-x-auto custom-scrollbar"></div>
    </div>
  `;
    const tableEl = container.querySelector('#provider-stats-table');
    const modelsEl = container.querySelector('#provider-models-table');
    function renderTables(data) {
        const providers = data?.providers || [];
        const models = data?.models || [];
        tableEl.innerHTML = providers.length
            ? `<table class="w-full text-left text-xs"><thead class="text-zinc-500 uppercase text-[9px]"><tr>
          <th class="px-2 py-2">Provider</th>
          <th class="px-2 py-2 text-right">Requests</th>
          <th class="px-2 py-2 text-right">Success</th>
          <th class="px-2 py-2 text-right">Latency</th>
          <th class="px-2 py-2 text-right">Tokens In</th>
          <th class="px-2 py-2 text-right">Tokens Out</th>
        </tr></thead><tbody class="divide-y divide-white/5">${providers.map((p) => {
                const successPct = p.totalRequests > 0 ? (p.successfulRequests / p.totalRequests) * 100 : 0;
                const srColor = successPct >= 90 ? 'text-success' : successPct >= 50 ? 'text-warning' : 'text-danger';
                return `<tr class="hover:bg-white/[0.02]">
            <td class="px-2 py-1.5 font-semibold text-zinc-200">${escapeHtml(p.provider)}</td>
            <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${p.totalRequests}</td>
            <td class="px-2 py-1.5 text-right font-mono ${srColor}">${fmtPct(successPct)}</td>
            <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtMs(p.avgLatencyMs)}</td>
            <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtNum(p.totalTokensIn)}</td>
            <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtNum(p.totalTokensOut)}</td>
          </tr>`;
            }).join('')}</tbody></table>`
            : '<div class="text-zinc-600 text-xs py-4 text-center">No provider stats available</div>';
        modelsEl.innerHTML = models.length
            ? `<table class="w-full text-left text-xs"><thead class="text-zinc-500 uppercase text-[9px]"><tr>
          <th class="px-2 py-2">Model</th>
          <th class="px-2 py-2">Provider</th>
          <th class="px-2 py-2 text-right">Requests</th>
          <th class="px-2 py-2 text-right">Success</th>
          <th class="px-2 py-2 text-right">Latency</th>
        </tr></thead><tbody class="divide-y divide-white/5">${models.map((m) => {
                const successPct = m.requests > 0 ? (m.successfulRequests / m.requests) * 100 : 0;
                const srColor = successPct >= 90 ? 'text-success' : successPct >= 50 ? 'text-warning' : 'text-danger';
                return `<tr class="hover:bg-white/[0.02]">
            <td class="px-2 py-1.5 font-mono text-zinc-200 text-[10px]">${escapeHtml(m.model)}</td>
            <td class="px-2 py-1.5 text-zinc-400 capitalize text-[10px]">${escapeHtml(m.provider)}</td>
            <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${m.requests}</td>
            <td class="px-2 py-1.5 text-right font-mono ${srColor}">${fmtPct(successPct)}</td>
            <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtMs(m.avgLatencyMs)}</td>
          </tr>`;
            }).join('')}</tbody></table>`
            : '<div class="text-zinc-600 text-xs py-4 text-center">No model data available</div>';
    }
    function renderLatencyChart(data) {
        const providers = data?.providers || [];
        const labels = providers.map((p) => p.provider?.split('(')[0]?.trim() || '?');
        const latencies = providers.map((p) => p.avgLatencyMs || 0);
        const colors = latencies.map((l) => l > 10000 ? '#f43f5e' : l > 5000 ? '#f59e0b' : '#10b981');
        const canvas = document.getElementById('provider-latency-canvas');
        if (!canvas)
            return;
        if (_latencyChartInstance)
            _latencyChartInstance.destroy();
        _latencyChartInstance = new window.Chart(canvas, {
            type: 'bar',
            data: {
                labels,
                datasets: [{ label: 'Avg Latency (ms)', data: latencies, backgroundColor: colors, borderRadius: 3 }],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => fmtMs(ctx.raw),
                        },
                    },
                },
                scales: {
                    x: { ticks: { color: '#52525b', font: { size: 9 } }, grid: { color: '#27272a' } },
                    y: { ticks: { color: '#a1a1aa', font: { size: 9 } }, grid: { display: false } },
                },
            },
        });
    }
    const update = () => {
        if (state.activeTab !== 'provider-stats')
            return;
        const stats = state.modelRouterStats;
        if (!stats) {
            container.innerHTML = '<div class="text-zinc-500 text-xs py-8 text-center">Waiting for Model Router provider stats...</div>';
            return;
        }
        // Transform model-router stats into provider-stats format
        const providers = Object.entries(stats.byTier || {}).map(([key, val]) => ({
            provider: key,
            totalRequests: val.calls || 0,
            successfulRequests: val.calls || 0,
            avgLatencyMs: 0,
            totalTokensIn: val.tokensIn || 0,
            totalTokensOut: val.tokensOut || 0,
        }));
        const models = Object.entries(stats.perModel || {}).map(([key, val]) => ({
            model: key,
            provider: 'opencode-free',
            requests: val.calls || 0,
            successfulRequests: (val.calls || 0) - (val.failures || 0),
            avgLatencyMs: 0,
        }));
        const data = { providers, models };
        renderTables(data);
        renderLatencyChart(data);
    };
    state.subscribe(update);
    update();
}
