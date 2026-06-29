import { formatNumber } from '../utils/format.js';

function fmtTime(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function fmtDate(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleString([], { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function mountSessions(container, state) {
  container.innerHTML = `
    <div class="flex flex-col h-full">
      <h3 class="text-sm font-semibold text-zinc-200 mb-4 flex items-center justify-between">
        <span>Recent Sessions</span>
        <span id="sessions-count" class="text-[10px] font-normal text-zinc-500 bg-zinc-800/60 px-2 py-0.5 rounded border border-white/5">0</span>
      </h3>
      <div class="overflow-y-auto flex-1 pr-1 custom-scrollbar min-h-0" id="sessions-feed">
        <div class="text-zinc-600 text-xs py-8 text-center select-none">No sessions yet</div>
      </div>
    </div>
  `;

  const feed = container.querySelector('#sessions-feed');
  const countEl = container.querySelector('#sessions-count');

  const render = () => {
    if (state.activeTab !== 'overview') return;
    const sessions = state.sessions || [];
    countEl.textContent = `${sessions.length} sessions`;

    if (sessions.length === 0) {
      feed.innerHTML = '<div class="text-zinc-600 text-xs py-8 text-center select-none">No sessions yet</div>';
      return;
    }

    feed.innerHTML = sessions.map(s => {
      const modelShort = (s.model || '').split('/').pop() || s.model || '—';
      const tokens = s.total_tokens || 0;
      const cost = s.cost || 0;
      return `<div class="flex items-center justify-between bg-white/[0.01] border border-white/5 hover:border-white/10 rounded-lg p-3 transition-all duration-200">
        <div class="min-w-0 flex-1 pr-3">
          <div class="flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0"></span>
            <span class="text-xs font-semibold text-zinc-200 truncate">${s.agent || 'Agent'}</span>
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-[10px] text-zinc-500 font-mono truncate max-w-[120px]" title="${s.model || ''}">${modelShort}</span>
            <span class="text-[9px] text-zinc-700">·</span>
            <span class="text-[9px] text-zinc-600">${fmtTime(s.ts)}</span>
          </div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-xs font-mono font-bold text-purple-400 tabular-nums">${formatNumber(tokens)} tk</div>
          ${cost > 0 ? `<div class="text-[9px] font-mono text-success/70 tabular-nums">$${cost.toFixed(4)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  };

  state.subscribe(render);
  render();
}