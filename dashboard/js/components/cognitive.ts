export function mountCognitive(container, state) {
  container.innerHTML = `
    <h3 class="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
      <svg class="w-4 h-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/>
        <path d="M20 12v2a8 8 0 0 1-16 0v-2"/>
        <path d="M12 12v8"/>
        <path d="M8 22h8"/>
      </svg>
      <span>SOTA Stats</span>
    </h3>
    <div id="cognitive-stats-grid" class="grid grid-cols-2 gap-3">
      <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4 space-y-2 min-h-[80px]">
        <div class="flex items-center justify-between">
          <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Cache</span>
          <span class="text-cyan-400 text-[9px]">⚡</span>
        </div>
        <div class="flex items-end gap-1.5">
          <span id="cs-cache" class="text-xl font-bold text-white tabular-nums">0</span>
          <span class="text-[10px] text-zinc-600 pb-0.5">entries</span>
        </div>
      </div>
      <div class="bg-white/[0.01] border border-white/5 rounded-xl p-4 space-y-2 min-h-[80px]">
        <div class="flex items-center justify-between">
          <span class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Distillation</span>
          <span class="text-amber-400 text-[9px]">🧪</span>
        </div>
        <div class="flex items-end gap-1.5">
          <span id="cs-distill" class="text-xl font-bold text-white tabular-nums">0</span>
          <span class="text-[10px] text-zinc-600 pb-0.5">samples</span>
        </div>
      </div>
    </div>
  `;

  const cacheEl = container.querySelector('#cs-cache');
  const distillEl = container.querySelector('#cs-distill');

  const update = () => {
    if (state.activeTab !== 'overview') return;
    const s = state.sotaStats;
    if (!s) return;
    cacheEl.textContent = s.cacheEntries || 0;
    distillEl.textContent = s.distillationSamples || 0;
  };

  state.subscribe(() => update());
  update();
}