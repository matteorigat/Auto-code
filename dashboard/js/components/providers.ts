import { formatNumber } from '../utils/format.js';
import { escapeHtml } from '../utils/sanitize.js';
import { resolveLimit, PROVIDER_LABELS } from '../limits.js';

const STATE_COLORS: Record<string, string> = {
  healthy: 'bg-success text-success border-success/20',
  degraded: 'bg-warning/10 text-warning border-warning/20',
  down: 'bg-danger/10 text-danger border-danger/20',
};

function stateBadge(state: string, score: number): string {
  const c = STATE_COLORS[state] || 'bg-zinc-800/40 text-zinc-400 border-zinc-700/30';
  const dot = state === 'healthy' ? 'bg-success' : state === 'degraded' ? 'bg-warning' : 'bg-danger';
  return `<span class="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border ${c}"><span class="w-1.5 h-1.5 rounded-full ${dot}"></span>${escapeHtml(state)}</span>`;
}

function fmtMs(ms: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(n: number): string {
  if (n == null) return '—';
  return `${n.toFixed(1)}%`;
}

function bar(val: number, max: number, color: string): string {
  const pct = max > 0 ? Math.min(100, (val / max) * 100) : 0;
  return `<div class="flex-1 bg-zinc-800/40 rounded-full h-1.5 overflow-hidden"><div class="h-full rounded-full transition-all duration-700 ${color}" style="width:${pct}%"></div></div>`;
}

export function mountProviders(container, state) {
  container.innerHTML = `
    <h3 class="text-sm font-semibold text-zinc-200 mb-4">Provider Health & Activity</h3>

    <!-- OmniRoute Health Matrix -->
    <div id="or-health-matrix" class="mb-6">
      <div class="flex items-center justify-between mb-3">
        <span class="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Real-Time Health Matrix</span>
        <span id="matrix-time" class="text-[9px] text-zinc-600 font-mono">—</span>
      </div>
      <div id="matrix-summary" class="flex flex-wrap gap-3 mb-3">
        <div class="bg-white/[0.01] border border-white/5 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full bg-success"></span>
          <span id="m-healthy" class="text-[11px] font-bold text-zinc-200">0</span>
          <span class="text-[9px] text-zinc-500">healthy</span>
        </div>
        <div class="bg-white/[0.01] border border-white/5 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full bg-warning"></span>
          <span id="m-degraded" class="text-[11px] font-bold text-zinc-200">0</span>
          <span class="text-[9px] text-zinc-500">degraded</span>
        </div>
        <div class="bg-white/[0.01] border border-white/5 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full bg-danger"></span>
          <span id="m-down" class="text-[11px] font-bold text-zinc-200">0</span>
          <span class="text-[9px] text-zinc-500">down</span>
        </div>
        <div class="bg-white/[0.01] border border-white/5 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span class="text-[9px] text-zinc-500">issues:</span>
          <span id="m-issues" class="text-[11px] font-bold text-warning">0</span>
        </div>
        <div class="bg-white/[0.01] border border-white/5 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span class="text-[9px] text-zinc-500">models:</span>
          <span id="m-models" class="text-[11px] font-bold text-zinc-200">0</span>
        </div>
      </div>
      <div id="matrix-cards" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 mb-4">
        <div class="text-zinc-600 text-xs py-4 text-center col-span-full">Loading health data...</div>
      </div>
      <div class="border-t border-white/5 my-4"></div>
    </div>

    <!-- Fallback Activity Table (existing) -->
    <div class="overflow-x-auto custom-scrollbar">
      <table class="w-full text-left text-sm text-zinc-400">
        <thead class="text-xs uppercase bg-zinc-800/50 text-zinc-300">
          <tr>
            <th class="px-4 py-3 rounded-tl-lg">Provider</th>
            <th class="px-4 py-3">Calls</th>
            <th class="px-4 py-3">Models Used</th>
            <th class="px-4 py-3">Est. Spend</th>
            <th class="px-4 py-3">RPM</th>
            <th class="px-4 py-3 rounded-tr-lg">RPD</th>
          </tr>
        </thead>
        <tbody id="provider-table-rows" class="divide-y divide-zinc-800/50 text-xs">
          <tr>
            <td colspan="6" class="px-4 py-6 text-center text-zinc-500">Loading provider stats...</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;

  const tbody = container.querySelector('#provider-table-rows');
  const matrixCards = container.querySelector('#matrix-cards');
  const matrixTime = container.querySelector('#matrix-time');
  const mHealthy = container.querySelector('#m-healthy');
  const mDegraded = container.querySelector('#m-degraded');
  const mDown = container.querySelector('#m-down');
  const mIssues = container.querySelector('#m-issues');
  const mModels = container.querySelector('#m-models');

  function renderMatrix() {
    const matrix = state.providerHealthMatrix;
    if (!matrix || !matrix.providers) {
      matrixCards.innerHTML = '<div class="text-zinc-600 text-xs py-4 text-center col-span-full">OmniRoute health-matrix unavailable</div>';
      return;
    }

    const summary = matrix.summary || {};
    mHealthy.textContent = summary.healthyCount ?? '?';
    mDegraded.textContent = summary.degradedCount ?? '?';
    mDown.textContent = summary.downCount ?? '?';
    mIssues.textContent = summary.issueCount ?? '?';
    mModels.textContent = summary.modelCount ?? '?';
    matrixTime.textContent = matrix.checkedAt ? new Date(matrix.checkedAt).toLocaleTimeString() : '—';

    matrixCards.innerHTML = (matrix.providers as any[] || []).map(p => {
      const conn = p.connections || {};
      const activeBar = bar(conn.active || 0, conn.total || 1, 'bg-success');
      const totalConns = conn.total || 0;
      const srColor = p.successRate >= 95 ? 'text-success' : p.successRate >= 80 ? 'text-warning' : 'text-danger';

      return `<div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 hover:border-white/10 transition">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-semibold text-zinc-200 capitalize">${escapeHtml(p.provider)}</span>
          ${stateBadge(p.state, p.score)}
        </div>
        <div class="space-y-1.5 text-[10px]">
          <div class="flex items-center justify-between">
            <span class="text-zinc-500">Score</span>
            <span class="font-mono font-bold text-zinc-200">${(p.score * 100).toFixed(0)}%</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-zinc-500">Connections</span>
            <span class="font-mono text-zinc-300">${totalConns} (${conn.active || 0} active)</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-zinc-500 w-16 shrink-0">Active</span>
            ${activeBar}
            <span class="font-mono text-zinc-400 w-12 text-right">${conn.active || 0}/${totalConns}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-zinc-500">Requests</span>
            <span class="font-mono text-zinc-300">${p.requests || 0}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-zinc-500">Success</span>
            <span class="font-mono font-bold ${srColor}">${fmtPct(p.successRate)}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-zinc-500">Latency</span>
            <span class="font-mono text-zinc-300">${fmtMs(p.avgLatencyMs)}</span>
          </div>
          ${p.circuitBreaker ? `<div class="flex items-center gap-1.5 text-danger/80 font-semibold"><span class="w-1 h-1 rounded-full bg-danger pulse-dot"></span>Circuit open</div>` : ''}
          ${p.lastRequestAt ? `<div class="text-[8px] text-zinc-600 font-mono mt-1 border-t border-white/[0.02] pt-1">last: ${new Date(p.lastRequestAt).toLocaleTimeString()}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  function renderTable() {
    if (state.activeTab !== 'quotas') return;
    const byModel = (state.summary && state.summary.byModel) || [];
    const quota = state.quota || {};

    const provMap = {};
    for (const m of byModel) {
      const p = m.provider || 'unknown';
      if (!provMap[p]) provMap[p] = { provider: p, calls: 0, cost: 0, models: [] };
      provMap[p].calls += m.total_calls || 0;
      provMap[p].cost += m.total_cost || 0;
      if (m.model) provMap[p].models.push(m.model);
    }

    const rows = Object.keys(provMap).map(p => {
      const _q = getQuotaEntry(quota, p);
      const q = _q as any;
      let rpmUsed = 0, rpmLimit: number | null = null, rpdUsed = 0, rpdLimit: number | null = null;
      if (q) {
        if (q.type === 'per-model' && q.models) {
          for (const mk of Object.keys(q.models)) {
            rpmUsed += q.models[mk].rpmUsed || 0;
            rpdUsed += q.models[mk].rpdUsed || 0;
          }
          const modelEntries = Object.values(q.models) as any[];
          const anyRpmLimit = modelEntries.find((m: any) => m.rpmLimit != null);
          rpmLimit = anyRpmLimit ? anyRpmLimit.rpmLimit : null;
          const anyRpdLimit = modelEntries.find((m: any) => m.rpdLimit != null);
          rpdLimit = anyRpdLimit ? anyRpdLimit.rpdLimit : null;
        } else {
          rpmUsed = q.rpmUsed || 0; rpmLimit = q.rpmLimit || null;
          rpdUsed = q.rpdUsed || 0; rpdLimit = q.rpdLimit || null;
        }
      }
      if (!rpmLimit && !rpdLimit) {
        const lim = resolveLimit(p, provMap[p].models[0] || '');
        if (lim) { rpmLimit = lim.rpm; rpdLimit = lim.rpd; }
      }
      return { ...provMap[p], rpmUsed, rpmLimit, rpdUsed, rpdLimit };
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-6 text-center text-zinc-500">No active provider sessions</td></tr>';
      return;
    }

    rows.sort((a, b) => b.calls - a.calls);
    tbody.innerHTML = rows.map(p => {
      const modelLines = p.models.map(m => `· ${escapeHtml(m.split('/').pop())}`).join('<br>');
      return `<tr class="hover:bg-white/5 transition">
        <td class="px-4 py-3 font-semibold text-zinc-200 capitalize">${escapeHtml(p.provider)}</td>
        <td class="px-4 py-3 code-font font-medium align-top">${formatNumber(p.calls)}</td>
        <td class="px-4 py-3 text-zinc-400 font-mono text-[10px] leading-5 select-all">${modelLines || '<span class="text-zinc-600">—</span>'}</td>
        <td class="px-4 py-3 text-success font-medium code-font align-top">$${Number(p.cost).toFixed(4)}</td>
        <td class="px-4 py-3 align-top">${bar(p.rpmUsed, p.rpmLimit, 'RPM')}</td>
        <td class="px-4 py-3 align-top">${bar(p.rpdUsed, p.rpdLimit, 'RPD')}</td>
      </tr>`;
    }).join('');
  }

  function bar(used, limit, label) {
    if (limit == null) {
      return `<div class="flex items-center gap-2 text-[10px]">
        <span class="text-zinc-500 w-6 shrink-0 font-mono">${label}</span>
        <div class="flex-1 text-zinc-600 font-mono">—</div>
        <span class="text-zinc-400 font-mono w-24 text-right shrink-0">${used}</span>
      </div>`;
    }
    const pct = Math.min(100, Math.max(0, (used / limit) * 100));
    const color = pct > 80 ? 'bg-danger' : pct > 60 ? 'bg-warning' : 'bg-emerald-500';
    return `<div class="flex items-center gap-2 text-[10px]">
      <span class="text-zinc-500 w-6 shrink-0 font-mono">${label}</span>
      <div class="flex-1 bg-zinc-900 rounded-full h-2 overflow-hidden border border-white/5">
        <div class="${color} h-2 rounded-full transition-all" style="width:${pct}%"></div>
      </div>
      <span class="text-zinc-400 font-mono w-24 text-right shrink-0">${used} / ${limit}</span>
    </div>`;
  }

  function getQuotaEntry(quota: any, provider: string): any {
    if (!quota) return null;
    if (quota[provider]) return quota[provider];
    const lower = Object.keys(quota).find(k => k.toLowerCase() === provider.toLowerCase());
    return lower ? quota[lower] : null;
  }

  const update = () => {
    if (state.activeTab !== 'quotas') return;
    renderMatrix();
    renderTable();
  };

  state.subscribe(update);
  update();
}

export function mountQuotaGauges(container, state) {
  container.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <div>
        <h3 class="text-sm font-semibold text-zinc-200">Real-Time Usage</h3>
        <p id="quota-subtitle" class="text-[10px] text-zinc-500 mt-0.5">Refresh every 5s — sliding-window</p>
      </div>
      <span id="quota-timestamp" class="text-[10px] text-zinc-600 font-mono">--</span>
    </div>
    <div id="quota-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"></div>
  `;

  const grid = container.querySelector('#quota-grid');
  const tsEl = container.querySelector('#quota-timestamp');

  const update = () => {
    if (state.activeTab !== 'quotas') return;
    const quota = state.quota || {};

    tsEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    let html = '';
    for (const [key, _q] of Object.entries(quota)) {
      const q = _q as any;
      let rpmUsed = 0, rpmLimit: number | null = null, rphUsed = 0, rphLimit: number | null = null, rpdUsed = 0, rpdLimit: number | null = null;

      if (q.type === 'per-model' && q.models) {
        for (const mk of Object.keys(q.models)) {
          rpmUsed += q.models[mk].rpmUsed || 0;
          rphUsed += q.models[mk].rphUsed || 0;
          rpdUsed += q.models[mk].rpdUsed || 0;
          if (q.models[mk].rpmLimit != null) rpmLimit = Math.max(rpmLimit || 0, q.models[mk].rpmLimit);
          if (q.models[mk].rphLimit != null) rphLimit = Math.max(rphLimit || 0, q.models[mk].rphLimit);
          if (q.models[mk].rpdLimit != null) rpdLimit = Math.max(rpdLimit || 0, q.models[mk].rpdLimit);
        }
      } else {
        rpmUsed = q.rpmUsed || 0; rpmLimit = q.rpmLimit || null;
        rphUsed = q.rphUsed || 0; rphLimit = q.rphLimit || null;
        rpdUsed = q.rpdUsed || 0; rpdLimit = q.rpdLimit || null;
      }

      if (rpmLimit == null && rphLimit == null && rpdLimit == null) continue;

      const cd = q.inCooldown
        ? `<span class="inline-flex items-center gap-1 text-[10px] text-danger font-semibold"><span class="w-1.5 h-1.5 rounded-full bg-danger animate-pulse"></span>COOLDOWN ${Math.round(q.cooldownRemaining / 1000)}s</span>`
        : '';

      const metrics = [
        { l: 'RPM', u: rpmUsed, m: rpmLimit },
        { l: 'RPH', u: rphUsed, m: rphLimit },
        { l: 'RPD', u: rpdUsed, m: rpdLimit },
      ].map(({ l, u, m }) => {
        const val = m != null ? `${u}/${m}` : `${u}`;
        if (m == null) return `<div class="flex items-center gap-2 text-[10px]"><span class="text-zinc-500 w-6 shrink-0 font-mono font-medium">${l}</span><span class="flex-1 text-zinc-600 font-mono">—</span><span class="text-zinc-400 font-mono w-20 text-right shrink-0">${val}</span></div>`;
        const pct = Math.min(100, Math.max(0, (u / m) * 100));
        const c = pct > 80 ? 'bg-danger' : pct > 60 ? 'bg-warning' : 'bg-success';
        const tc = pct > 80 ? 'text-danger' : 'text-zinc-300';
        return `<div class="flex items-center gap-2 text-[10px]"><span class="text-zinc-500 w-6 shrink-0 font-mono font-medium">${l}</span><div class="flex-1 bg-zinc-700/50 rounded-full h-1.5 overflow-hidden"><div class="h-full ${c} rounded-full transition-all duration-700" style="width:${pct}%"></div></div><span class="${tc} font-mono w-20 text-right shrink-0">${val}</span></div>`;
      }).join('');

      html += `<div class="bg-zinc-800/20 border border-zinc-700/40 rounded-xl p-4 hover:border-zinc-600/60 transition-colors">
        <div class="flex justify-between items-center mb-3">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full ${q.type === 'opportunistic' ? 'bg-zinc-500' : 'bg-success'}"></span>
            <span class="text-sm font-semibold text-zinc-200">${escapeHtml(PROVIDER_LABELS[key] || key)}</span>
          </div>
          ${cd}
        </div>
        <div class="space-y-1.5">${metrics}</div>
      </div>`;
    }

    grid.innerHTML = html || '<div class="text-zinc-500 text-xs py-8 text-center col-span-full">No providers configured</div>';
  };

  state.subscribe(update);
  update();
}
