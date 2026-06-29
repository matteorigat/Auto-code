import { escapeHtml } from '../../../utils/sanitize.js';
import { icons } from '../icons.js';
export class CredentialsView {
    constructor(api, state, cache) {
        this.api = api;
        this.state = state;
        this.cache = cache;
    }
    async mount(container) {
        this.container = document.createElement('div');
        this.container.className = 'h-full flex flex-col gap-4';
        container.appendChild(this.container);
        this._renderStatic();
        await this.loadCredentials();
    }
    unmount() { }
    _renderStatic() {
        this.container.innerHTML = `
      <div class="shrink-0">
        <h1 class="text-xl font-bold text-white tracking-tight">LLM Provider Credentials</h1>
        <p class="text-sm text-zinc-400 mt-1">Verify environment API tokens loaded in active containers</p>
      </div>
      <div id="creds-cards" class="flex-grow min-h-0 overflow-y-auto custom-scrollbar space-y-3">
        <div class="flex items-center justify-center py-16">
          <span class="mm-spin" style="width:24px;height:24px;display:block;color:#71717a">${icons.spinner}</span>
          <span class="ml-3 text-zinc-500 text-sm">Loading credentials...</span>
        </div>
      </div>
    `;
        this.cardsEl = this.container.querySelector('#creds-cards');
    }
    async loadCredentials() {
        try {
            const creds = await this.api.get('/model-credentials');
            if (!creds || !creds.length) {
                this.cardsEl.innerHTML = `<div class="mm-empty-state"><div class="es-icon" style="width:48px;height:48px">${icons.key}</div><p class="text-sm text-zinc-500">No credentials found.</p></div>`;
                return;
            }
            this.cardsEl.innerHTML = creds
                .map((c) => {
                const isActive = c.status === 'Active';
                return `
        <div class="mm-health-card ${isActive ? 'healthy' : 'unhealthy'} flex items-center gap-4">
          <span class="mm-status-dot ${isActive ? 'healthy' : 'unhealthy'}"></span>
          <div class="flex-grow min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-white">${escapeHtml(c.provider)}</span>
              <span class="text-[10px] font-mono ${c.source === 'env' ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : 'text-purple-400 bg-purple-500/10 border-purple-500/20'} px-2 py-0.5 rounded border">${c.source === 'env' ? 'ENV' : 'YAML'}</span>
            </div>
            <div class="text-xs text-zinc-400 font-mono mt-1">${escapeHtml(c.keyName)}</div>
          </div>
          <div class="text-xs text-zinc-500 font-mono">${escapeHtml(c.masked)}</div>
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${isActive ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
            ${isActive ? 'Active' : 'Missing'}
          </span>
        </div>`;
            })
                .join('');
        }
        catch (err) {
            this.cardsEl.innerHTML = `<div class="mm-empty-state"><p class="text-sm text-rose-400">Failed to load: ${escapeHtml(err.message)}</p></div>`;
        }
    }
}
