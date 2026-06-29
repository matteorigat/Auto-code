import { escapeHtml } from '../../../utils/sanitize.js';
import { icons } from '../icons.js';
export class EndpointsView {
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
        await this.loadEndpoints();
    }
    unmount() { }
    _renderStatic() {
        this.container.innerHTML = `
      <div class="shrink-0">
        <h1 class="text-xl font-bold text-white tracking-tight">Active Proxy Endpoints</h1>
        <p class="text-sm text-zinc-400 mt-1">Endpoints exposed by local LiteLLM container on port 4000</p>
      </div>
      <div id="endpoints-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 flex-grow min-h-0 overflow-y-auto custom-scrollbar content-start">
        <div class="col-span-full flex items-center justify-center py-16">
          <span class="mm-spin" style="width:24px;height:24px;display:block;color:#71717a">${icons.spinner}</span>
          <span class="ml-3 text-zinc-500 text-sm">Probing endpoints...</span>
        </div>
      </div>
    `;
        this.grid = this.container.querySelector('#endpoints-grid');
    }
    async loadEndpoints() {
        try {
            const endpoints = await this.api.get('/model-endpoints');
            if (!endpoints || !endpoints.length) {
                this.grid.innerHTML = `<div class="col-span-full mm-empty-state"><div class="es-icon">${icons.network}</div><p class="text-sm text-zinc-500">No endpoints configured.</p></div>`;
                return;
            }
            this.grid.innerHTML = endpoints
                .map((ep) => {
                const isActive = ep.status !== 'Error';
                return `
        <div class="mm-health-card ${isActive ? 'healthy' : 'unhealthy'}">
          <div class="flex items-center gap-2 mb-2">
            <span class="mm-status-dot ${isActive ? 'healthy' : 'unhealthy'}"></span>
            <span class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">${escapeHtml(ep.name)}</span>
          </div>
          <div class="text-sm font-mono text-white font-semibold mb-2">${escapeHtml(ep.path)}</div>
          <div class="text-xs ${isActive ? 'text-emerald-400' : 'text-rose-400'} flex items-center gap-1.5">
            <span>${isActive ? '&#10003;' : '&#9888;'}</span> ${escapeHtml(ep.details)}
          </div>
        </div>`;
            })
                .join('');
        }
        catch (err) {
            this.grid.innerHTML = `<div class="col-span-full mm-empty-state"><p class="text-sm text-rose-400">Failed to probe: ${escapeHtml(err.message)}</p></div>`;
        }
    }
}
