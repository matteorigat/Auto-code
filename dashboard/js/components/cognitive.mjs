import { escapeHtml as sanitize } from '../utils/sanitize.mjs';

export function mountCognitive(container, state) {
  container.innerHTML = `
    <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">SOTA Stats</h3>
    <div class="grid grid-cols-2 gap-4" id="cognitive-stats-grid">
      <div class="text-gray-500 text-sm">Loading SOTA stats...</div>
    </div>
  `;

  const grid = container.querySelector('#cognitive-stats-grid');

  const update = () => {
    if (state.activeTab !== 'overview') return;
    if (!state.sotaStats) return;

    grid.innerHTML = `
      <div class="bg-surface/50 border border-white/5 rounded-lg p-4">
        <div class="text-gray-400 text-xs uppercase tracking-wider mb-1">Semantic Cache</div>
        <div class="flex items-end gap-2">
          <div class="text-2xl font-bold text-white">${state.sotaStats.cacheEntries || 0}</div>
          <div class="text-xs text-gray-500 pb-1">entries</div>
        </div>
      </div>
      <div class="bg-surface/50 border border-white/5 rounded-lg p-4">
        <div class="text-gray-400 text-xs uppercase tracking-wider mb-1">Distillation</div>
        <div class="flex items-end gap-2">
          <div class="text-2xl font-bold text-white">${state.sotaStats.distillationSamples || 0}</div>
          <div class="text-xs text-gray-500 pb-1">samples</div>
        </div>
      </div>
    `;
  };

  state.subscribe(() => update());
  update();
}
