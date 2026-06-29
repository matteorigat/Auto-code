import { escapeHtml } from '../utils/sanitize.js';

function kpiCard(label: string, value: string, sub: string, color: string): string {
  return `<div class="bg-white/[0.01] border border-white/5 rounded-xl p-4 hover:border-white/10 transition">
    <div class="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-1">${escapeHtml(label)}</div>
    <div class="text-lg font-bold ${color}">${escapeHtml(value)}</div>
    <div class="text-[10px] text-zinc-600 mt-0.5">${escapeHtml(sub)}</div>
  </div>`;
}

function fmtMs(ms: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(n: number): string {
  return n != null ? `${n.toFixed(1)}%` : '—';
}

function fmtNum(n: number): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

let _usageChartInstance: any = null;
let _weeklyChartInstance: any = null;

export function mountUsageCharts(container: HTMLElement, state: any) {
  container.innerHTML = `
    <div id="usage-kpis" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5"></div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
      <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4">
        <h4 class="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-3">Daily Requests & Tokens</h4>
        <div class="h-56 relative"><canvas id="usage-trend-canvas"></canvas></div>
      </div>
      <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4">
        <h4 class="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-3">Weekly Pattern</h4>
        <div class="h-56 relative"><canvas id="usage-weekly-canvas"></canvas></div>
      </div>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
      <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4">
        <h4 class="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-3">By Provider</h4>
        <div id="usage-by-provider" class="overflow-x-auto custom-scrollbar"></div>
      </div>
      <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4">
        <h4 class="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-3">By Model</h4>
        <div id="usage-by-model" class="overflow-x-auto custom-scrollbar"></div>
      </div>
    </div>
  `;

  const kpisEl = container.querySelector('#usage-kpis');
  const byProviderEl = container.querySelector('#usage-by-provider');
  const byModelEl = container.querySelector('#usage-by-model');

  function renderKPIs(data: any) {
    const s = data?.summary || {};
    kpisEl.innerHTML =
      kpiCard('Total Requests', fmtNum(s.totalRequests), `${fmtPct(s.successRatePct)} success`, 'text-zinc-200') +
      kpiCard('Avg Latency', fmtMs(s.avgLatencyMs), `p50: ${fmtMs(s.avgLatencyMs)}`, s.avgLatencyMs > 5000 ? 'text-warning' : 'text-zinc-200') +
      kpiCard('Total Tokens', fmtNum(s.totalTokens), `${fmtNum(s.promptTokens)} in / ${fmtNum(s.completionTokens)} out`, 'text-accentBlue') +
      kpiCard('Models / Accounts', `${s.uniqueModels || 0} models`, `${s.uniqueAccounts || 0} accounts`, 'text-zinc-200');
  }

  function renderTables(data: any) {
    const byProvider = data?.byProvider || [];
    const byModel = data?.byModel || [];

    byProviderEl.innerHTML = byProvider.length
      ? `<table class="w-full text-left text-xs"><thead class="text-zinc-500 uppercase text-[9px]"><tr>
          <th class="px-2 py-2">Provider</th>
          <th class="px-2 py-2 text-right">Requests</th>
          <th class="px-2 py-2 text-right">Success</th>
          <th class="px-2 py-2 text-right">Latency</th>
          <th class="px-2 py-2 text-right">Tokens</th>
        </tr></thead><tbody class="divide-y divide-white/5">${byProvider.map((p: any) =>
          `<tr class="hover:bg-white/[0.02]"><td class="px-2 py-1.5 font-semibold text-zinc-200 capitalize">${escapeHtml(p.provider)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${p.requests}</td>
          <td class="px-2 py-1.5 text-right font-mono ${p.successRatePct >= 90 ? 'text-success' : p.successRatePct >= 50 ? 'text-warning' : 'text-danger'}">${fmtPct(p.successRatePct)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtMs(p.avgLatencyMs)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtNum(p.totalTokens)}</td></tr>`
        ).join('')}</tbody></table>`
      : '<div class="text-zinc-600 text-xs py-4 text-center">No provider data</div>';

    byModelEl.innerHTML = byModel.length
      ? `<table class="w-full text-left text-xs"><thead class="text-zinc-500 uppercase text-[9px]"><tr>
          <th class="px-2 py-2">Model</th>
          <th class="px-2 py-2">Provider</th>
          <th class="px-2 py-2 text-right">Requests</th>
          <th class="px-2 py-2 text-right">Success</th>
          <th class="px-2 py-2 text-right">Latency</th>
          <th class="px-2 py-2 text-right">Tokens</th>
        </tr></thead><tbody class="divide-y divide-white/5">${byModel.map((m: any) =>
          `<tr class="hover:bg-white/[0.02]"><td class="px-2 py-1.5 font-mono text-zinc-200 text-[10px]">${escapeHtml(m.model)}</td>
          <td class="px-2 py-1.5 text-zinc-400 capitalize text-[10px]">${escapeHtml(m.provider)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${m.requests}</td>
          <td class="px-2 py-1.5 text-right font-mono ${m.successRatePct >= 90 ? 'text-success' : m.successRatePct >= 50 ? 'text-warning' : 'text-danger'}">${fmtPct(m.successRatePct)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtMs(m.avgLatencyMs)}</td>
          <td class="px-2 py-1.5 text-right font-mono text-zinc-300">${fmtNum(m.totalTokens)}</td></tr>`
        ).join('')}</tbody></table>`
      : '<div class="text-zinc-600 text-xs py-4 text-center">No model data</div>';
  }

  function renderCharts(data: any) {
    const trend = data?.dailyTrend || [];
    const labels = trend.map((d: any) => d.date?.substring(5) || '');
    const reqData = trend.map((d: any) => d.requests || 0);
    const tokData = trend.map((d: any) => Math.round((d.totalTokens || 0) / 1000));

    const trendCanvas = document.getElementById('usage-trend-canvas') as HTMLCanvasElement;
    if (trendCanvas) {
      if (_usageChartInstance) _usageChartInstance.destroy();
      _usageChartInstance = new (window as any).Chart(trendCanvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Requests', data: reqData, backgroundColor: '#3b82f6', borderRadius: 3, yAxisID: 'y' },
            { label: 'Tokens (K)', data: tokData, backgroundColor: '#8b5cf6', borderRadius: 3, yAxisID: 'y1' },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#a1a1aa', font: { size: 10 }, boxWidth: 10, boxHeight: 10 } } },
          scales: {
            x: { ticks: { color: '#52525b', font: { size: 9 } }, grid: { color: '#27272a' } },
            y: { ticks: { color: '#52525b', font: { size: 9 } }, grid: { color: '#27272a' }, position: 'left' },
            y1: { ticks: { color: '#52525b', font: { size: 9 } }, grid: { display: false }, position: 'right' },
          },
        },
      });
    }

    const weekly = data?.weeklyCounts || [];
    const weeklyLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weeklyCanvas = document.getElementById('usage-weekly-canvas') as HTMLCanvasElement;
    if (weeklyCanvas) {
      if (_weeklyChartInstance) _weeklyChartInstance.destroy();
      _weeklyChartInstance = new (window as any).Chart(weeklyCanvas, {
        type: 'bar',
        data: {
          labels: weeklyLabels,
          datasets: [
            { label: 'Requests', data: weekly, backgroundColor: '#10b981', borderRadius: 3 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#a1a1aa', font: { size: 10 }, boxWidth: 10, boxHeight: 10 } } },
          scales: {
            x: { ticks: { color: '#52525b', font: { size: 9 } }, grid: { color: '#27272a' } },
            y: { ticks: { color: '#52525b', font: { size: 9 } }, grid: { color: '#27272a' } },
          },
        },
      });
    }
  }

  const update = () => {
    if (state.activeTab !== 'usage-charts') return;
    const data = state.omnirouteUsageAnalytics;
    if (!data) {
      container.innerHTML = '<div class="text-zinc-500 text-xs py-8 text-center">Waiting for OmniRoute usage data...</div>';
      return;
    }
    renderKPIs(data);
    renderTables(data);
    renderCharts(data);
  };

  state.subscribe(update);
  update();
}
