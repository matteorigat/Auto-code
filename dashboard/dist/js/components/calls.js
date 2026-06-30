import { escapeHtml } from '../utils/sanitize.js';
function fmtNum(n) {
    if (n === undefined || n === null)
        return '—';
    return new Intl.NumberFormat().format(n);
}
function fmtTime(ts) {
    if (!ts)
        return '--';
    return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDate(ts) {
    if (!ts)
        return '--';
    return new Date(ts).toLocaleString([], { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtCost(n) {
    if (n === undefined || n === null || n === 0)
        return '—';
    if (n < 0.001)
        return `$${n.toExponential(2)}`;
    return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}
const PROVIDER_COLORS = {
    'model-router': 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    openrouter: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    groq: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    openai: 'bg-green-500/10 text-green-400 border-green-500/20',
    anthropic: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    mistral: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    google: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
    cerebras: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    nvidia: 'bg-lime-500/10 text-lime-400 border-lime-500/20',
};
function providerBadge(p) {
    const c = PROVIDER_COLORS[p?.toLowerCase()] || 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20';
    return `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded border ${c}">${escapeHtml(p || 'unknown')}</span>`;
}
function highlightJSON(obj) {
    const json = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    if (json.length > 5000)
        return escapeHtml(json.slice(0, 5000)) + '\n… (truncated)';
    return json.replace(/("(?:\\.|[^"\\])*")\s*:/g, '<span class="text-cyan-400">$1</span>:')
        .replace(/:\s*("(?:\\.|[^"\\])*")/g, ': <span class="text-amber-300">$1</span>')
        .replace(/:\s*(true|false)/g, ': <span class="text-purple-400">$1</span>')
        .replace(/:\s*(\d+\.?\d*)/g, ': <span class="text-accentBlue">$1</span>')
        .replace(/:\s*(null)/g, ': <span class="text-zinc-500">$1</span>');
}
function copyToClip(text, btn) {
    navigator.clipboard?.writeText(text).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '<span class="text-success">✓ Copied</span>';
        btn.disabled = true;
        setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
    }).catch(() => { });
}
export function mountCalls(container, state) {
    let selectedIndex = -1;
    let searchQuery = '';
    let statusFilter = 'all';
    container.innerHTML = `
    <div class="flex flex-col h-full gap-4">
      <!-- Summary bar -->
      <div id="calls-summary" class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-center min-h-[52px]">
          <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Total Calls</span>
          <span id="cs-total" class="text-white font-bold text-sm mt-0.5 tabular-nums">0</span>
        </div>
        <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-center min-h-[52px]">
          <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Total Tokens</span>
          <span id="cs-tokens" class="text-accentBlue font-bold text-sm mt-0.5 tabular-nums">0</span>
        </div>
        <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-center min-h-[52px]">
          <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Total Cost</span>
          <span id="cs-cost" class="text-success font-bold text-sm mt-0.5 tabular-nums">$0.00</span>
        </div>
        <div class="bg-white/[0.01] border border-white/5 rounded-xl p-3 flex flex-col justify-center min-h-[52px]">
          <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Success Rate</span>
          <span id="cs-rate" class="text-green-400 font-bold text-sm mt-0.5 tabular-nums">—</span>
        </div>
      </div>

      <!-- Toolbar -->
      <div class="flex items-center gap-2.5 flex-wrap">
        <div class="relative flex-1 min-w-[160px] max-w-xs">
          <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="calls-search" type="text" placeholder="Search model, provider..." autocomplete="off" class="w-full bg-zinc-800/60 border border-zinc-700/50 text-xs rounded-lg pl-8 pr-3 py-2 outline-none focus:border-primary/50 text-zinc-200 placeholder-zinc-600 transition-colors" />
        </div>
        <select id="calls-status-filter" class="bg-zinc-800/60 border border-zinc-700/50 text-xs rounded-lg px-3 py-2 outline-none focus:border-primary/50 text-zinc-300 transition-colors cursor-pointer">
          <option value="all">All Status</option>
          <option value="ok">OK Only</option>
          <option value="error">Errors Only</option>
        </select>
        <span id="calls-count" class="text-[10px] text-zinc-500 font-mono ml-auto"></span>
      </div>

      <!-- Main split -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 flex-1 min-h-0">
        <!-- Table -->
        <div class="flex flex-col min-h-0 bg-white/[0.01] border border-white/5 rounded-xl overflow-hidden">
          <div class="overflow-y-auto flex-1 custom-scrollbar">
            <table class="w-full text-left text-xs text-zinc-400">
              <thead class="text-[10px] uppercase bg-zinc-800/40 text-zinc-400 sticky top-0 z-10 backdrop-blur-md">
                <tr>
                  <th class="px-3 py-2.5 font-semibold">Time</th>
                  <th class="px-3 py-2.5 font-semibold">Model</th>
                  <th class="px-3 py-2.5 font-semibold hidden sm:table-cell">Provider</th>
                  <th class="px-3 py-2.5 font-semibold text-right">Tokens</th>
                  <th class="px-3 py-2.5 font-semibold text-right hidden md:table-cell">Cost</th>
                  <th class="px-3 py-2.5 font-semibold text-center">Status</th>
                </tr>
              </thead>
              <tbody id="calls-table-rows" class="divide-y divide-zinc-800/30"></tbody>
            </table>
          </div>
        </div>

        <!-- Detail pane -->
        <div id="call-detail-pane" class="flex flex-col min-h-0 bg-white/[0.01] border border-white/5 rounded-xl p-4 overflow-hidden">
          <div class="flex flex-col items-center justify-center h-full text-zinc-500 text-xs select-none">
            <svg class="w-10 h-10 text-zinc-700 mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <span class="text-zinc-600 font-medium">Select a call to inspect</span>
            <span class="text-zinc-700 text-[10px] mt-1">Click any row in the table</span>
          </div>
        </div>
      </div>
    </div>
  `;
    const els = {
        tbody: container.querySelector('#calls-table-rows'),
        detailPane: container.querySelector('#call-detail-pane'),
        search: container.querySelector('#calls-search'),
        filter: container.querySelector('#calls-status-filter'),
        count: container.querySelector('#calls-count'),
        csTotal: container.querySelector('#cs-total'),
        csTokens: container.querySelector('#cs-tokens'),
        csCost: container.querySelector('#cs-cost'),
        csRate: container.querySelector('#cs-rate'),
    };
    function getFilteredCalls() {
        let list = state.calls || [];
        if (statusFilter !== 'all') {
            list = list.filter(c => statusFilter === 'ok' ? c.status === 'ok' : c.status !== 'ok');
        }
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            list = list.filter(c => (c.model || '').toLowerCase().includes(q) ||
                (c.provider || '').toLowerCase().includes(q) ||
                (c.prompt || '').toLowerCase().includes(q) ||
                (c.response || '').toLowerCase().includes(q));
        }
        return list;
    }
    function updateSummary(calls) {
        const total = calls.length;
        const tokens = calls.reduce((s, c) => s + (c.total_tokens || 0), 0);
        const cost = calls.reduce((s, c) => s + (c.data?.cost || c.data?.data?.promptCache?.lastCallUsage?.cost?.total || c.data?.promptCache?.lastCallUsage?.cost?.total || 0), 0);
        const ok = calls.filter(c => c.status === 'ok').length;
        const rate = total > 0 ? (ok / total * 100) : 0;
        els.csTotal.textContent = fmtNum(total);
        els.csTokens.textContent = fmtNum(tokens);
        els.csCost.textContent = fmtCost(cost);
        els.csRate.textContent = total > 0 ? `${rate.toFixed(1)}%` : '—';
    }
    function renderTable() {
        const filtered = getFilteredCalls();
        const all = state.calls || [];
        els.count.textContent = all.length > 0 ? `${filtered.length} / ${all.length}` : '';
        updateSummary(all);
        if (filtered.length === 0) {
            els.tbody.innerHTML = `<tr><td colspan="6" class="px-3 py-8 text-center text-zinc-600 select-none text-xs">${all.length === 0 ? 'No API calls recorded yet' : 'No calls match your filters'}</td></tr>`;
            selectedIndex = -1;
            return;
        }
        els.tbody.innerHTML = filtered.map((call, idx) => {
            const isErr = call.status !== 'ok';
            const modelShort = (call.model || '').split('/').pop() || call.model;
            const timeStr = fmtTime(call.ts);
            const cost = call.data?.cost || call.data?.data?.promptCache?.lastCallUsage?.cost?.total || call.data?.promptCache?.lastCallUsage?.cost?.total || 0;
            const isSel = state.calls.indexOf(call) === selectedIndex;
            const borderCls = isErr ? 'border-l-2 border-l-danger/40' : 'border-l-2 border-l-transparent';
            return `<tr data-idx="${idx}" class="hover:bg-white/[0.02] transition cursor-pointer select-none ${borderCls}${isSel ? ' bg-primary/[0.06] border-l-primary' : ''}">
        <td class="px-3 py-2.5 font-mono text-zinc-500 whitespace-nowrap">${timeStr}</td>
        <td class="px-3 py-2.5 truncate max-w-[160px] font-medium text-zinc-200" title="${escapeHtml(call.model)}">${escapeHtml(modelShort)}</td>
        <td class="px-3 py-2.5 hidden sm:table-cell">${providerBadge(call.provider)}</td>
        <td class="px-3 py-2.5 font-mono text-accentBlue text-right tabular-nums whitespace-nowrap">${fmtNum(call.total_tokens)}</td>
        <td class="px-3 py-2.5 font-mono text-right tabular-nums whitespace-nowrap hidden md:table-cell ${cost > 0 ? 'text-success/80' : 'text-zinc-600'}">${fmtCost(cost)}</td>
        <td class="px-3 py-2.5 text-center">${isErr
                ? '<span class="inline-flex items-center gap-1 text-[9px] font-bold text-danger bg-danger/10 px-1.5 py-0.5 rounded border border-danger/15"><span class="w-1 h-1 rounded-full bg-danger"></span>ERR</span>'
                : '<span class="inline-flex items-center gap-1 text-[9px] font-bold text-success bg-success/10 px-1.5 py-0.5 rounded border border-success/15"><span class="w-1 h-1 rounded-full bg-success"></span>OK</span>'}</td>
      </tr>`;
        }).join('');
        els.tbody.querySelectorAll('tr').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.idx);
                const filtered = getFilteredCalls();
                const call = filtered[idx];
                if (!call)
                    return;
                selectedIndex = state.calls.indexOf(call);
                renderTable();
                renderDetail(call);
            });
        });
    }
    function renderDetail(call) {
        if (!call)
            return;
        const cost = call.data?.cost || call.data?.data?.promptCache?.lastCallUsage?.cost?.total || call.data?.promptCache?.lastCallUsage?.cost?.total || 0;
        const input = call.input_tokens || 0;
        const output = call.output_tokens || 0;
        const promptText = call.prompt || call.data?.prompt || '';
        const respText = call.response || call.data?.response || '';
        const rawData = call.data || {};
        const isErr = call.status !== 'ok';
        const detailId = 'call-detail-content-' + Date.now();
        els.detailPane.innerHTML = `
      <div class="flex flex-col h-full overflow-hidden">
        <div class="flex items-center justify-between border-b border-white/5 pb-3 mb-3 shrink-0">
          <h3 class="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full ${isErr ? 'bg-danger pulse-dot' : 'bg-success'}"></span>
            Call Details
          </h3>
          <div class="flex items-center gap-2">
            <span class="text-[10px] text-zinc-500 font-mono">${fmtTime(call.ts)}</span>
          </div>
        </div>

        <!-- Metadata grid -->
        <div class="grid grid-cols-2 gap-2 text-[11px] bg-white/[0.01] border border-white/5 rounded-lg p-3 mb-3 shrink-0">
          <div class="col-span-2 flex items-center gap-2 min-w-0">
            <span class="text-zinc-500 font-semibold uppercase tracking-wider text-[9px] shrink-0">Model</span>
            <span class="text-primary font-mono truncate select-all" title="${escapeHtml(call.model)}">${escapeHtml(call.model)}</span>
            <button class="copy-btn ml-auto shrink-0 text-[9px] font-bold px-2 py-0.5 rounded bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-400 border border-zinc-700/30 transition outline-none" data-copy="${escapeHtml(call.model)}">Copy</button>
          </div>
          <div>
            <span class="text-zinc-500 font-semibold uppercase tracking-wider text-[9px]">Provider</span>
            <div class="mt-0.5">${providerBadge(call.provider)}</div>
          </div>
          <div>
            <span class="text-zinc-500 font-semibold uppercase tracking-wider text-[9px]">Status</span>
            <div class="mt-0.5">${isErr
            ? '<span class="text-[9px] font-bold text-danger bg-danger/10 px-1.5 py-0.5 rounded border border-danger/15">✗ Error</span>'
            : '<span class="text-[9px] font-bold text-success bg-success/10 px-1.5 py-0.5 rounded border border-success/15">✓ Success</span>'}</div>
          </div>
          <div>
            <span class="text-zinc-500 font-semibold uppercase tracking-wider text-[9px]">Tokens</span>
            <span class="text-zinc-200 font-mono font-medium mt-0.5 block tabular-nums">${fmtNum(input)} in / ${fmtNum(output)} out</span>
          </div>
          <div>
            <span class="text-zinc-500 font-semibold uppercase tracking-wider text-[9px]">Cost</span>
            <span class="${cost > 0 ? 'text-success' : 'text-zinc-600'} font-mono font-medium mt-0.5 block tabular-nums">${fmtCost(cost)}</span>
          </div>
          <div class="col-span-2">
            <span class="text-zinc-500 font-semibold uppercase tracking-wider text-[9px]">Timestamp</span>
            <span class="text-zinc-400 font-mono text-[10px] mt-0.5 block">${fmtDate(call.ts)}</span>
          </div>
        </div>

        <!-- Tabs -->
        <div class="flex gap-1 border-b border-white/5 mb-3 shrink-0" id="detail-tabs-${detailId}">
          <button class="dtab text-[10px] font-bold px-3 py-1.5 rounded-t-lg transition outline-none text-primary border-b-2 border-primary" data-tab="request">Request</button>
          <button class="dtab text-[10px] font-bold px-3 py-1.5 rounded-t-lg transition outline-none text-zinc-500 hover:text-zinc-300" data-tab="response">Response</button>
          <button class="dtab text-[10px] font-bold px-3 py-1.5 rounded-t-lg transition outline-none text-zinc-500 hover:text-zinc-300" data-tab="raw">Raw JSON</button>
        </div>

        <div id="detail-body-${detailId}" class="flex-1 overflow-y-auto custom-scrollbar min-h-0">
          <div class="space-y-2" id="dt-request">
            <div class="flex items-center justify-between">
              <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Prompt Content</span>
              <button class="copy-btn text-[9px] font-bold px-2 py-0.5 rounded bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-400 border border-zinc-700/30 transition outline-none" data-copy="${escapeHtml(promptText.slice(0, 500))}">Copy</button>
            </div>
            <div class="bg-zinc-950/60 p-3 rounded-lg border border-white/5 max-h-[260px] overflow-y-auto custom-scrollbar code-font text-[10px] text-zinc-400 select-all whitespace-pre-wrap leading-relaxed">${promptText ? escapeHtml(promptText) : '<span class="text-zinc-600 italic">No prompt content available</span>'}</div>
          </div>
          <div class="space-y-2 hidden" id="dt-response">
            <div class="flex items-center justify-between">
              <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Response Content</span>
              <button class="copy-btn text-[9px] font-bold px-2 py-0.5 rounded bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-400 border border-zinc-700/30 transition outline-none" data-copy="${escapeHtml((respText || '').slice(0, 500))}">Copy</button>
            </div>
            <div class="${isErr ? 'bg-danger/5 border-danger/10 text-danger' : 'bg-zinc-950/60 border-white/5 text-zinc-400'} p-3 rounded-lg border max-h-[260px] overflow-y-auto custom-scrollbar code-font text-[10px] select-all whitespace-pre-wrap leading-relaxed">${respText ? escapeHtml(respText) : '<span class="text-zinc-600 italic">No response content available</span>'}</div>
          </div>
          <div class="space-y-2 hidden" id="dt-raw">
            <div class="flex items-center justify-between">
              <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Full Payload</span>
              <button class="copy-btn text-[9px] font-bold px-2 py-0.5 rounded bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-400 border border-zinc-700/30 transition outline-none" data-raw="1">Copy</button>
            </div>
            <div class="bg-zinc-950/60 p-3 rounded-lg border border-white/5 max-h-[320px] overflow-y-auto custom-scrollbar code-font text-[10px] text-zinc-400 select-all whitespace-pre-wrap leading-relaxed">${highlightJSON(rawData)}</div>
          </div>
        </div>
      </div>
    `;
        // Tab switching
        const tabs = els.detailPane.querySelectorAll('.dtab');
        const bodies = {
            request: els.detailPane.querySelector('#dt-request'),
            response: els.detailPane.querySelector('#dt-response'),
            raw: els.detailPane.querySelector('#dt-raw'),
        };
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => { t.className = 'dtab text-[10px] font-bold px-3 py-1.5 rounded-t-lg transition outline-none text-zinc-500 hover:text-zinc-300'; });
                tab.className = 'dtab text-[10px] font-bold px-3 py-1.5 rounded-t-lg transition outline-none text-primary border-b-2 border-primary';
                Object.keys(bodies).forEach(k => bodies[k].classList.add('hidden'));
                const t = bodies[tab.dataset.tab];
                if (t)
                    t.classList.remove('hidden');
            });
        });
        // Copy buttons
        els.detailPane.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.raw === '1') {
                    copyToClip(JSON.stringify(rawData, null, 2), btn);
                }
                else if (btn.dataset.copy) {
                    copyToClip(btn.dataset.copy, btn);
                }
            });
        });
    }
    // Event bindings
    els.search.addEventListener('input', () => {
        searchQuery = els.search.value;
        selectedIndex = -1;
        renderTable();
    });
    els.filter.addEventListener('change', () => {
        statusFilter = els.filter.value;
        selectedIndex = -1;
        renderTable();
    });
    state.subscribe(() => {
        if (state.activeTab !== 'explorer')
            return;
        const prev = els.tbody.querySelector('tr.bg-primary\\/\\[0\\.06\\]');
        renderTable();
    });
    renderTable();
}
