import { escapeHtml as sanitize } from '../utils/sanitize.js';
export function mountRouting(container, state) {
    container.innerHTML = `
    <h3 class="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4 flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <span>Model Routing Chain</span>
      </div>
      <span id="routing-tier-label" class="text-[9px] font-bold text-zinc-400 bg-zinc-800/60 px-1.5 py-0.5 rounded border border-white/5 tracking-wider uppercase hidden"></span>
    </h3>
    <div class="flex flex-col space-y-3" id="routing-chain-list">
      <!-- Chain injected here -->
      <div class="text-zinc-500 text-sm">Loading routing chain...</div>
    </div>
  `;
    const list = container.querySelector('#routing-chain-list');
    const tierLabelEl = container.querySelector('#routing-tier-label');
    const update = () => {
        if (state.activeTab !== 'overview')
            return;
        if (!state.routingChain || state.routingChain.length === 0) {
            list.innerHTML = `<div class="text-zinc-500 text-xs py-4 text-center">No routing chain available.</div>`;
            tierLabelEl.classList.add('hidden');
            return;
        }
        // Determine current tier
        const firstStep = state.routingChain[0];
        if (firstStep && firstStep.alias) {
            const match = firstStep.alias.match(/tier-(\d+)/);
            if (match) {
                tierLabelEl.textContent = `Current Tier ${match[1]}`;
                tierLabelEl.classList.remove('hidden');
            }
            else {
                tierLabelEl.classList.add('hidden');
            }
        }
        else {
            tierLabelEl.classList.add('hidden');
        }
        list.innerHTML = state.routingChain
            .map((step, i) => {
            const isPrimary = i === 0;
            // Parse model details
            const alias = step.alias || 'unknown';
            const model = step.model || 'unknown';
            const provider = step.provider || 'unknown';
            const rpm = step.rpm;
            const timeout = step.timeout;
            const context = step.context;
            // Provider badge color
            let providerBadge = `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-zinc-800 text-zinc-400 border border-white/5 uppercase">${sanitize(provider)}</span>`;
            if (provider === 'opencode' || provider === 'opencode_zen') {
                providerBadge = `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20">OpenCode</span>`;
            }
            else if (provider === 'openrouter') {
                providerBadge = `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20">OpenRouter</span>`;
            }
            else if (provider === 'mistral') {
                providerBadge = `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-500/10 text-orange-400 border border-orange-500/20">Mistral</span>`;
            }
            else if (provider === 'groq') {
                providerBadge = `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-yellow-500/10 text-yellow-500 border border-yellow-500/20">Groq</span>`;
            }
            else if (provider === 'nvidia') {
                providerBadge = `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Nvidia</span>`;
            }
            // Context window format
            let ctxStr = '';
            if (context) {
                ctxStr =
                    context >= 1000000
                        ? `${(context / 1000000).toFixed(0)}M ctx`
                        : `${(context / 1000).toFixed(0)}k ctx`;
            }
            return `
        <div class="flex flex-col bg-white/[0.01] p-3.5 rounded-xl border ${isPrimary ? 'border-primary/20 bg-primary/[0.01]' : 'border-white/5'} hover:border-white/10 transition">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="flex-shrink-0 w-5 h-5 rounded-lg bg-${isPrimary ? 'primary/15' : 'white/[0.02]'} border ${isPrimary ? 'border-primary/20' : 'border-white/5'} flex items-center justify-center text-[10px] font-bold ${isPrimary ? 'text-primary' : 'text-zinc-500'}">
                ${i + 1}
              </div>
              <div class="min-w-0">
                <div class="text-xs font-semibold text-zinc-100 truncate" title="${sanitize(model)}">${sanitize(model)}</div>
                <div class="text-[9px] text-zinc-500 font-mono mt-0.5">${sanitize(alias)}</div>
              </div>
            </div>
            ${isPrimary
                ? '<span class="text-[9px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded border border-primary/25 uppercase tracking-wider flex-shrink-0 shadow-sm">Primary</span>'
                : '<span class="text-[9px] font-bold text-zinc-500 bg-zinc-800/40 px-1.5 py-0.5 rounded border border-white/5 uppercase tracking-wider flex-shrink-0">Fallback</span>'}
          </div>
          
          <!-- Bottom meta stats -->
          <div class="flex items-center gap-2.5 mt-3 pt-2.5 border-t border-white/[0.03]">
            ${providerBadge}
            ${ctxStr ? `<span class="text-[9px] font-medium text-zinc-500 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-zinc-700"></span>${ctxStr}</span>` : ''}
            ${rpm ? `<span class="text-[9px] font-medium text-zinc-500 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-zinc-700"></span>${rpm} RPM</span>` : ''}
            ${timeout ? `<span class="text-[9px] font-medium text-zinc-500 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-zinc-700"></span>${timeout}s t/o</span>` : ''}
          </div>
        </div>
        ${i < state.routingChain.length - 1
                ? `
          <div class="flex justify-center my-0.5 opacity-20">
            <svg class="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 14l-7 7m0 0l-7-7m7 7V3"/>
            </svg>
          </div>
        `
                : ''}
      `;
        })
            .join('');
    };
    state.subscribe(() => update());
    update();
}
