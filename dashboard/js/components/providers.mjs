import { formatNumber } from '../utils/format.mjs';
import { escapeHtml } from '../utils/sanitize.mjs';
import { resolveLimit, PROVIDER_LABELS } from '../limits.mjs';

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

function getQuotaEntry(quota, provider) {
  if (!quota) return null;
  if (quota[provider]) return quota[provider];
  const lower = Object.keys(quota).find((k) => k.toLowerCase() === provider.toLowerCase());
  return lower ? quota[lower] : null;
}

export function mountProviders(container, state) {
  container.innerHTML = `
    <h3 class="text-sm font-semibold text-zinc-200 mb-4">Fallback Activity (Provider Usage)</h3>
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

  const update = () => {
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

    const rows = Object.keys(provMap).map((p) => {
      const q = getQuotaEntry(quota, p);
      let rpmUsed = 0,
        rpmLimit = null,
        rpdUsed = 0,
        rpdLimit = null;
      if (q) {
        if (q.type === 'per-model' && q.models) {
          for (const mk of Object.keys(q.models)) {
            rpmUsed += q.models[mk].rpmUsed || 0;
            rpdUsed += q.models[mk].rpdUsed || 0;
          }
          const anyRpmLimit = Object.values(q.models).find((m) => m.rpmLimit != null);
          rpmLimit = anyRpmLimit ? anyRpmLimit.rpmLimit : null;
          const anyRpdLimit = Object.values(q.models).find((m) => m.rpdLimit != null);
          rpdLimit = anyRpdLimit ? anyRpdLimit.rpdLimit : null;
        } else {
          rpmUsed = q.rpmUsed || 0;
          rpmLimit = q.rpmLimit || null;
          rpdUsed = q.rpdUsed || 0;
          rpdLimit = q.rpdLimit || null;
        }
      }
      if (!rpmLimit && !rpdLimit) {
        const lim = resolveLimit(p, provMap[p].models[0] || '');
        if (lim) {
          rpmLimit = lim.rpm;
          rpdLimit = lim.rpd;
        }
      }
      return { ...provMap[p], rpmUsed, rpmLimit, rpdUsed, rpdLimit };
    });

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="px-4 py-6 text-center text-zinc-500">No active provider sessions</td></tr>';
      return;
    }

    rows.sort((a, b) => b.calls - a.calls);

    tbody.innerHTML = rows
      .map((p) => {
        const modelLines = p.models.map((m) => `· ${escapeHtml(m.split('/').pop())}`).join('<br>');
        return `<tr class="hover:bg-white/5 transition">
        <td class="px-4 py-3 font-semibold text-zinc-200 capitalize">${escapeHtml(p.provider)}</td>
        <td class="px-4 py-3 code-font font-medium align-top">${formatNumber(p.calls)}</td>
        <td class="px-4 py-3 text-zinc-400 font-mono text-[10px] leading-5 select-all">${modelLines || '<span class="text-zinc-600">—</span>'}</td>
        <td class="px-4 py-3 text-success font-medium code-font align-top">$${Number(p.cost).toFixed(4)}</td>
        <td class="px-4 py-3 align-top">${bar(p.rpmUsed, p.rpmLimit, 'RPM')}</td>
        <td class="px-4 py-3 align-top">${bar(p.rpdUsed, p.rpdLimit, 'RPD')}</td>
      </tr>`;
      })
      .join('');
  };

  state.subscribe(update);
  update();
}

export function mountQuotaGauges(container, state) {
  const update = () => {
    if (state.activeTab !== 'quotas') return;
    const quota = state.quota || {};

    let html = '';
    for (const [key, q] of Object.entries(quota)) {
      let rpmUsed = 0,
        rpmLimit = null;
      let rphUsed = 0,
        rphLimit = null;
      let rpdUsed = 0,
        rpdLimit = null;

      if (q.type === 'per-model' && q.models) {
        for (const mk of Object.keys(q.models)) {
          rpmUsed += q.models[mk].rpmUsed || 0;
          rphUsed += q.models[mk].rphUsed || 0;
          rpdUsed += q.models[mk].rpdUsed || 0;
          if (q.models[mk].rpmLimit != null)
            rpmLimit = Math.max(rpmLimit || 0, q.models[mk].rpmLimit);
          if (q.models[mk].rphLimit != null)
            rphLimit = Math.max(rphLimit || 0, q.models[mk].rphLimit);
          if (q.models[mk].rpdLimit != null)
            rpdLimit = Math.max(rpdLimit || 0, q.models[mk].rpdLimit);
        }
      } else {
        rpmUsed = q.rpmUsed || 0;
        rpmLimit = q.rpmLimit || null;
        rphUsed = q.rphUsed || 0;
        rphLimit = q.rphLimit || null;
        rpdUsed = q.rpdUsed || 0;
        rpdLimit = q.rpdLimit || null;
      }

      if (rpmLimit == null && rphLimit == null && rpdLimit == null) continue;

      const cd = q.inCooldown
        ? `<span class="inline-flex items-center gap-1 text-[10px] text-danger font-semibold"><span class="w-1.5 h-1.5 rounded-full bg-danger animate-pulse"></span>COOLDOWN ${Math.round(q.cooldownRemaining / 1000)}s</span>`
        : '';

      const metrics = [
        { l: 'RPM', u: rpmUsed, m: rpmLimit },
        { l: 'RPH', u: rphUsed, m: rphLimit },
        { l: 'RPD', u: rpdUsed, m: rpdLimit },
      ]
        .map(({ l, u, m }) => {
          const val = m != null ? `${u}/${m}` : `${u}`;
          if (m == null)
            return `<div class="flex items-center gap-2 text-[10px]"><span class="text-zinc-500 w-6 shrink-0 font-mono font-medium">${l}</span><span class="flex-1 text-zinc-600 font-mono">—</span><span class="text-zinc-400 font-mono w-20 text-right shrink-0">${val}</span></div>`;
          const pct = Math.min(100, Math.max(0, (u / m) * 100));
          const c = pct > 80 ? 'bg-danger' : pct > 60 ? 'bg-warning' : 'bg-emerald-500';
          const tc = pct > 80 ? 'text-danger' : 'text-zinc-300';
          return `<div class="flex items-center gap-2 text-[10px]"><span class="text-zinc-500 w-6 shrink-0 font-mono font-medium">${l}</span><div class="flex-1 bg-zinc-700/50 rounded-full h-1.5 overflow-hidden"><div class="h-full ${c} rounded-full transition-all duration-700" style="width:${pct}%"></div></div><span class="${tc} font-mono w-20 text-right shrink-0">${val}</span></div>`;
        })
        .join('');

      html += `<div class="bg-zinc-800/20 border border-zinc-700/40 rounded-xl p-4 hover:border-zinc-600/60 transition-colors">
        <div class="flex justify-between items-center mb-3">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full ${q.type === 'opportunistic' ? 'bg-zinc-500' : 'bg-emerald-500'}"></span>
            <span class="text-sm font-semibold text-zinc-200">${escapeHtml(PROVIDER_LABELS[key] || key)}</span>
          </div>
          ${cd}
        </div>
        <div class="space-y-1.5">${metrics}</div>
      </div>`;
    }

    container.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-sm font-semibold text-zinc-200">Real-Time Usage</h3>
          <p class="text-[10px] text-zinc-500 mt-0.5">Aggiornato ogni 5s — valori sliding-window (${state.quota?.opencode_zen?.rphPeriod || 1}h per RPH)</p>
        </div>
        <span class="text-[10px] text-zinc-600 font-mono">${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
      </div>
      ${
        html
          ? `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${html}</div>`
          : '<div class="text-zinc-500 text-xs py-8 text-center">Nessun provider configurato</div>'
      }
    `;
  };

  state.subscribe(update);
  update();
}
