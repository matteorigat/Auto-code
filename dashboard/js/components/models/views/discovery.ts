import { escapeHtml } from '../../../utils/sanitize.js';
import { ModelToast } from '../model-toast.js';
import { icons } from '../icons.js';

export class DiscoveryView {
  [key: string]: any;
  constructor(api, state, cache) {
    this.api = api;
    this.state = state;
    this.cache = cache;
    this.data = null;
    this.isSubmitting = false;
    this.viewMode = state.get().discoveryViewMode || 'grid';
    this.compareSet = new Set();
    this._expandedProviders = new Set();
  }

  async mount(container) {
    this.container = document.createElement('div');
    this.container.className = 'h-full flex flex-col gap-4';
    container.appendChild(this.container);

    this._renderStatic();
    this._attachListeners();
    await this.loadDiscovery();
  }

  unmount() {}

  _renderStatic() {
    this.container.innerHTML = `
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shrink-0">
        <div>
          <h1 class="text-xl font-bold text-white tracking-tight">Model Discovery</h1>
          <p class="text-sm text-zinc-400 mt-1">Browse and install models from active providers</p>
        </div>
        <div class="flex items-center gap-3 w-full sm:w-auto">
          <div class="relative flex-1 sm:w-64">
            <span class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <span style="width:16px;height:16px;color:#71717a">${icons.search}</span>
            </span>
            <input type="text" id="disco-search" placeholder="Search models..." class="w-full pl-9 pr-4 py-2 bg-zinc-900/50 border border-white/5 focus:border-primary/50 focus:outline-none rounded-xl text-sm text-zinc-200">
          </div>
          <div class="flex items-center gap-1 bg-zinc-900/50 p-1 rounded-lg border border-white/5">
            <button data-dvmode="grid" class="p-1.5 rounded-md transition ${this.viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}" title="Card view">
              <span style="width:14px;height:14px;display:block">${icons.grid}</span>
            </button>
            <button data-dvmode="list" class="p-1.5 rounded-md transition ${this.viewMode === 'list' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}" title="List view">
              <span style="width:14px;height:14px;display:block">${icons.list}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 flex-wrap shrink-0" id="disco-filters">
        <select id="disco-sort" class="px-3 py-1.5 bg-zinc-900 border border-white/5 rounded-lg text-xs text-zinc-300 font-medium focus:outline-none focus:border-primary/50">
          <option value="name">Sort: Name</option>
          <option value="quality">Sort: Quality</option>
          <option value="context">Sort: Context Length</option>
        </select>
        <select id="disco-provider" class="px-3 py-1.5 bg-zinc-900 border border-white/5 rounded-lg text-xs text-zinc-300 font-medium focus:outline-none focus:border-primary/50">
          <option value="all">All Providers</option>
        </select>
        <button class="mm-chip" id="disco-free-toggle"><span style="width:12px;height:12px">${icons.zap}</span> Free Only</button>
        ${this.compareSet.size > 0 ? `<button class="mm-chip active" id="disco-compare-btn"><span style="width:12px;height:12px">${icons.compare}</span> Compare (${this.compareSet.size})</button>` : ''}
      </div>

      <div id="disco-compare-panel" class="${this.compareSet.size >= 2 ? '' : 'hidden'} shrink-0 glass-panel p-4">
        <div class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Comparison</div>
        <div id="disco-compare-content" class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4"></div>
      </div>

      <div id="disco-list" class="flex-grow min-h-0 overflow-y-auto custom-scrollbar">
        <div class="flex flex-col items-center justify-center py-24">
          <span class="mm-spin" style="width:32px;height:32px;display:block;color:#8b5cf6">${icons.spinner}</span>
          <span class="mt-4 text-sm text-zinc-500">Loading discovery data...</span>
        </div>
      </div>
    `;

    this.listEl = this.container.querySelector('#disco-list');
    this.searchEl = this.container.querySelector('#disco-search');
    this.providerEl = this.container.querySelector('#disco-provider');
    this.sortEl = this.container.querySelector('#disco-sort');
  }

  _attachListeners() {
    this.searchEl.addEventListener('input', () => this.renderList());
    this.providerEl.addEventListener('change', () => this.renderList());
    this.sortEl.addEventListener('change', () => this.renderList());

    this.container.querySelectorAll('[data-dvmode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.viewMode = btn.dataset.dvmode;
        this.state.update({ discoveryViewMode: this.viewMode });
        this.container.querySelectorAll('[data-dvmode]').forEach((b) => {
          b.classList.remove('bg-white/10', 'text-white');
          b.classList.add('text-zinc-500');
        });
        btn.classList.add('bg-white/10', 'text-white');
        btn.classList.remove('text-zinc-500');
        this.renderList();
      });
    });

    const freeToggle = this.container.querySelector('#disco-free-toggle');
    if (freeToggle) {
      const initFree = this.state.get().discoveryFreeOnly;
      if (initFree) freeToggle.classList.add('active');
      freeToggle.addEventListener('click', () => {
        const cur = this.state.get().discoveryFreeOnly;
        this.state.update({ discoveryFreeOnly: !cur });
        freeToggle.classList.toggle('active', !cur);
        this.renderList();
      });
    }

    this.listEl.addEventListener('click', async (e) => {
      const addBtn = e.target.closest('.disco-add');
      if (addBtn)
        await this.addModel(addBtn.dataset.id, addBtn.dataset.provider, addBtn.dataset.name);
      const rmBtn = e.target.closest('.disco-rm');
      if (rmBtn) await this.removeModel(rmBtn.dataset.id, rmBtn.dataset.provider);
      const cmpBtn = e.target.closest('.disco-cmp');
      if (cmpBtn) this._toggleCompare(cmpBtn.dataset.id, cmpBtn.dataset.provider);
    });
  }

  async loadDiscovery() {
    this.listEl.innerHTML = `
      <div class="flex flex-col items-center justify-center py-24">
        <span class="mm-spin" style="width:32px;height:32px;display:block;color:#8b5cf6">${icons.spinner}</span>
        <span class="mt-4 text-sm text-zinc-500">Loading discovery data...</span>
      </div>`;
    try {
      this.data = await this.api.get('/model-discovery', { timeout: 60000 });
      if (this.data && this.data.providers) {
        const providers = this.data.providers.filter((p) => p.models.length > 0);
        this.providerEl.innerHTML =
          '<option value="all">All Providers</option>' +
          providers
            .map((p) => `<option value="${escapeHtml(p.provider)}">${escapeHtml(p.label)}</option>`)
            .join('');
      }
      this.renderList();
    } catch (err) {
      const isTimeout = err.message?.toLowerCase().includes('timeout');
      this.listEl.innerHTML = `
        <div class="mm-empty-state">
          <div class="es-icon" style="width:48px;height:48px">${icons.compass}</div>
          <p class="text-sm ${isTimeout ? 'text-amber-400' : 'text-rose-400'}">${isTimeout ? 'Request timed out — the catalog server may be slow' : escapeHtml(err.message)}</p>
          <button data-retry-disc class="mt-4 px-4 py-2 rounded-xl bg-primary/10 border border-primary/20 text-sm text-primary hover:bg-primary/20 transition font-semibold">Retry</button>
        </div>`;
      const retryBtn = this.listEl.querySelector('[data-retry-disc]');
      if (retryBtn) retryBtn.addEventListener('click', () => this.loadDiscovery());
    }
  }

  _getAllModels() {
    if (!this.data || !this.data.providers) return [];
    const search = this.searchEl.value.toLowerCase();
    const providerFilter = this.providerEl.value;
    const freeOnly = this.state.get().discoveryFreeOnly;
    const configuredModels = new Set(this.data.configured_models || []);

    const allModels = [];
    for (const p of this.data.providers) {
      if (providerFilter !== 'all' && p.provider !== providerFilter) continue;
      if (p.error) continue;
      for (const m of p.models) {
        if (search) {
          const matchName = (m.name || '').toLowerCase().includes(search);
          const matchId = (m.id || '').toLowerCase().includes(search);
          if (!matchName && !matchId) continue;
        }
        if (freeOnly && !m.free) continue;
        allModels.push({
          ...m,
          _provider: p,
          _isConfigured:
            configuredModels.has(m.id) || configuredModels.has(`${p.provider}/${m.id}`),
        });
      }
    }
    return allModels;
  }

  _sortModels(models) {
    const sortBy = this.sortEl.value;
    return [...models].sort((a, b) => {
      if (sortBy === 'quality') return (b.quality_score || 0) - (a.quality_score || 0);
      if (sortBy === 'context') return (b.context || 0) - (a.context || 0);
      return (a.name || a.id || '').localeCompare(b.name || b.id || '');
    });
  }

  renderList() {
    if (!this.data || !this.data.providers) return;

    const search = this.searchEl.value.toLowerCase();
    const providerFilter = this.providerEl.value;
    const freeOnly = this.state.get().discoveryFreeOnly;
    const configuredModels = new Set(this.data.configured_models || []);
    const sortBy = this.sortEl.value;

    let totalCount = 0;
    let sections = '';

    for (const p of this.data.providers) {
      if (providerFilter !== 'all' && p.provider !== providerFilter) continue;
      if (p.error) continue;

      const models = [];
      for (const m of p.models) {
        if (search) {
          const matchName = (m.name || '').toLowerCase().includes(search);
          const matchId = (m.id || '').toLowerCase().includes(search);
          if (!matchName && !matchId) continue;
        }
        if (freeOnly && !m.free) continue;
        models.push({
          ...m,
          _provider: p,
          _isConfigured:
            configuredModels.has(m.id) || configuredModels.has(`${p.provider}/${m.id}`),
        });
      }

      if (models.length === 0) continue;
      totalCount += models.length;

      models.sort((a, b) => {
        if (sortBy === 'quality') return (b.quality_score || 0) - (a.quality_score || 0);
        if (sortBy === 'context') return (b.context || 0) - (a.context || 0);
        return (a.name || a.id || '').localeCompare(b.name || b.id || '');
      });

      const isExpanded =
        this._expandedProviders.has(p.provider) || this._expandedProviders.size === 0;

      sections += `
        <div class="glass-panel p-0 overflow-hidden mb-3">
          <button class="disc-prov-header flex items-center justify-between w-full px-4 py-3 bg-white/[0.02] border-b border-white/5 hover:bg-white/[0.04] transition cursor-pointer" data-prov="${escapeHtml(p.provider)}">
            <div class="flex items-center gap-3">
              <span class="mm-collapse-arrow ${isExpanded ? 'open' : ''}" style="width:14px;height:14px;color:#71717a">${icons.chevronRight}</span>
              <span class="text-sm font-semibold text-white">${escapeHtml(p.label || p.provider)}</span>
              <span class="text-[10px] font-mono text-zinc-500 bg-white/[0.03] px-2 py-0.5 rounded">${models.length}</span>
            </div>
            <span class="text-[10px] text-zinc-500 font-mono">${escapeHtml(p.provider)}</span>
          </button>
          <div class="disc-prov-body ${isExpanded ? '' : 'hidden'}" data-prov-body="${escapeHtml(p.provider)}">
            ${this.viewMode === 'grid' ? this._renderGrid(models) : this._renderList(models)}
          </div>
        </div>`;
    }

    if (!totalCount) {
      this.listEl.innerHTML = `<div class="mm-empty-state"><div class="es-icon">${icons.compass}</div><p class="text-sm">No models found matching criteria.</p></div>`;
      this._renderComparePanel();
      return;
    }

    this.listEl.innerHTML = sections;

    this.listEl.querySelectorAll('.disc-prov-header').forEach((header) => {
      header.addEventListener('click', () => {
        const prov = header.dataset.prov;
        const body = this.listEl.querySelector(`[data-prov-body="${prov}"]`);
        const arrow = header.querySelector('.mm-collapse-arrow');
        if (body) {
          body.classList.toggle('hidden');
          arrow.classList.toggle('open');
          if (body.classList.contains('hidden')) {
            this._expandedProviders.delete(prov);
          } else {
            this._expandedProviders.add(prov);
          }
        }
      });
    });

    this._renderComparePanel();
  }

  _qualityBadge(score, source) {
    if (score == null)
      return `<div class="flex items-center gap-1.5"><span style="width:14px;height:14px;color:#3f3f46" class="flex-shrink-0">${icons.brain}</span><span class="text-[11px] text-zinc-600 font-mono">—</span></div>`;
    const color =
      score >= 70 ? 'text-emerald-400' : score >= 40 ? 'text-amber-400' : 'text-zinc-400';
    const bgColor =
      score >= 70
        ? 'bg-emerald-500/10 border-emerald-500/20'
        : score >= 40
          ? 'bg-amber-500/10 border-amber-500/20'
          : 'bg-zinc-500/10 border-zinc-500/20';
    const pct = Math.min(100, Math.max(0, score));
    const sourceLabel =
      source === 'openrouter'
        ? 'OR'
        : source === 'larikoz'
          ? 'LK'
          : source === 'arena'
            ? 'AR'
            : source === 'aa'
              ? 'AA'
              : '';
    return `<div class="flex items-center gap-2">
      <span style="width:14px;height:14px" class="flex-shrink-0 ${color}">${icons.brain}</span>
      <span class="text-sm font-bold font-mono ${color}">${Math.round(score)}</span>
      <div class="mm-bench-bar-track flex-grow"><div class="mm-bench-bar-fill intel" style="width:${pct}%"></div></div>
      ${sourceLabel ? `<span class="text-[8px] font-mono text-zinc-600" title="Source: ${escapeHtml(source)}">${sourceLabel}</span>` : ''}
    </div>`;
  }

  _contextBadge(context, contextSource) {
    if (!context) return `<span class="text-[10px] text-zinc-600 font-mono">—</span>`;
    const ctx =
      context >= 1000000 ? `${(context / 1000000).toFixed(1)}M` : `${Math.round(context / 1000)}k`;
    const isCapped = contextSource === 'override';
    return `<span class="text-[10px] font-mono ${isCapped ? 'text-amber-400' : 'text-zinc-400'}" title="${isCapped ? 'Provider-specific limit (lower than model native)' : contextSource || 'unknown'}">${isCapped ? '⚠ ' : ''}${ctx}</span>`;
  }

  _renderGrid(models) {
    return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-1">${models
      .map((m) => {
        const cmpKey = `${m._provider.provider}/${m.id}`;
        const isComparing = this.compareSet.has(cmpKey);

        return `<div class="mm-disco-card ${m._isConfigured ? 'configured' : ''}">
        ${isComparing ? `<div class="mm-compare-badge">${Array.from(this.compareSet).indexOf(cmpKey) + 1}</div>` : ''}
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-white break-words">${escapeHtml(m.name || m.id)}</span>
              ${m.free ? '<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">FREE</span>' : ''}
            </div>
            <span class="text-[10px] font-mono text-zinc-500">${escapeHtml(m.id)}</span>
          </div>
          <span class="text-[10px] text-zinc-400 border border-white/5 bg-white/[0.03] rounded px-1.5 py-0.5 flex-shrink-0">${escapeHtml(m._provider.label)}</span>
        </div>

        <div class="mt-2">
          ${this._qualityBadge(m.quality_score, m.quality_source)}
        </div>

        <div class="flex items-center justify-between text-[10px] text-zinc-500 pt-2 border-t border-white/[0.03] mt-auto">
          <div class="flex items-center gap-1">
            <span style="width:10px;height:10px;color:#52525b">${icons.code}</span>
            Context: ${this._contextBadge(m.context, m.context_source)}
          </div>
        </div>

        <div class="flex items-center gap-2 mt-1">
          ${
            m._isConfigured
              ? `<button class="disco-rm px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 rounded-lg text-xs font-semibold transition flex-1" data-id="${escapeHtml(m.id)}" data-provider="${escapeHtml(m._provider.provider)}">Delete</button>`
              : `<button class="disco-add px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg text-xs font-semibold transition flex-1" data-id="${escapeHtml(m.id)}" data-provider="${escapeHtml(m._provider.provider)}" data-name="${escapeHtml(m.name || m.id)}">Add</button>`
          }
          <button class="disco-cmp p-1.5 rounded-lg border border-white/5 text-zinc-500 hover:text-white hover:border-white/10 transition ${isComparing ? 'bg-primary/10 text-primary border-primary/20' : ''}" data-id="${escapeHtml(m.id)}" data-provider="${escapeHtml(m._provider.provider)}" title="Compare">
            <span style="width:14px;height:14px;display:block">${icons.compare}</span>
          </button>
        </div>
      </div>`;
      })
      .join('')}</div>`;
  }

  _renderList(models) {
    return `<div class="border border-white/5 rounded-xl bg-white/[0.01] overflow-hidden">
      <div class="grid grid-cols-12 gap-4 px-4 py-3 border-b border-white/5 bg-zinc-900/90 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
        <div class="col-span-4">Model</div>
        <div class="col-span-2">Provider</div>
        <div class="col-span-3">Quality</div>
        <div class="col-span-1">Context</div>
        <div class="col-span-2 text-right">Action</div>
      </div>
      <div class="divide-y divide-white/[0.02]">${models
        .map((m) => {
          return `<div class="grid grid-cols-12 gap-4 px-4 py-3 hover:bg-white/[0.02] transition-colors items-center">
          <div class="col-span-4 flex flex-col">
            <span class="text-sm font-semibold text-white break-words">${escapeHtml(m.name || m.id)}</span>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span class="text-[10px] font-mono text-zinc-500">${escapeHtml(m.id)}</span>
              ${m.free ? '<span class="px-1 py-0 rounded text-[8px] font-bold bg-emerald-500/10 text-emerald-400">FREE</span>' : ''}
            </div>
          </div>
          <div class="col-span-2"><span class="text-xs text-zinc-400 border border-white/5 bg-white/[0.03] rounded px-2 py-1">${escapeHtml(m._provider.label)}</span></div>
          <div class="col-span-3">
            ${this._qualityBadge(m.quality_score, m.quality_source)}
          </div>
          <div class="col-span-1">
            ${this._contextBadge(m.context, m.context_source)}
          </div>
          <div class="col-span-2 flex justify-end gap-2">
            ${
              m._isConfigured
                ? `<button class="disco-rm px-2.5 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 rounded-lg text-xs font-semibold transition" data-id="${escapeHtml(m.id)}" data-provider="${escapeHtml(m._provider.provider)}">Delete</button>`
                : `<button class="disco-add px-2.5 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg text-xs font-semibold transition" data-id="${escapeHtml(m.id)}" data-provider="${escapeHtml(m._provider.provider)}" data-name="${escapeHtml(m.name || m.id)}">Add</button>`
            }
          </div>
        </div>`;
        })
        .join('')}</div>
    </div>`;
  }

  _toggleCompare(id, provider) {
    const key = `${provider}/${id}`;
    if (this.compareSet.has(key)) {
      this.compareSet.delete(key);
    } else if (this.compareSet.size < 4) {
      this.compareSet.add(key);
    } else {
      ModelToast.show('Max 4 models for comparison', 'warning');
      return;
    }
    this._renderStatic();
    this._attachListeners();
    this.renderList();
  }

  _renderComparePanel() {
    const panel = this.container.querySelector('#disco-compare-panel');
    const content = this.container.querySelector('#disco-compare-content');
    if (!panel || !content || this.compareSet.size < 2) {
      if (panel) panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');

    if (!this.data) return;
    const allModels = this._getAllModels();
    const keys = Array.from(this.compareSet);
    const cmpModels = [];
    for (const key of keys) {
      const m = allModels.find((x) => `${x._provider.provider}/${x.id}` === key);
      if (m) cmpModels.push(m);
    }

    content.innerHTML = `<div class="grid gap-4" style="grid-template-columns:repeat(${Math.min(cmpModels.length, 4)}, 1fr)">${cmpModels
      .map((m) => {
        const bestQuality =
          cmpModels.length > 1 &&
          m.quality_score != null &&
          m.quality_score === Math.max(...cmpModels.map((x) => x.quality_score || 0));
        const color =
          m.quality_score >= 70
            ? 'text-emerald-400'
            : m.quality_score >= 40
              ? 'text-amber-400'
              : 'text-zinc-400';

        return `<div class="bg-white/[0.02] border border-white/5 rounded-xl p-4 space-y-3">
        <div class="text-sm font-semibold text-white truncate">${escapeHtml(m.name || m.id)}</div>
        <div class="${bestQuality ? 'bg-purple-500/[0.04] rounded-lg p-2' : 'p-2'}">
          <div class="flex items-center justify-between text-[10px] mb-1">
            <span class="text-zinc-400">Quality</span>
            <span class="font-mono text-base ${bestQuality ? 'text-purple-400 font-bold' : color}">${m.quality_score != null ? Math.round(m.quality_score) : '—'}</span>
          </div>
          <div class="mm-bench-bar-track"><div class="mm-bench-bar-fill intel" style="width:${m.quality_score || 0}%"></div></div>
          ${m.quality_source ? `<div class="text-[8px] text-zinc-600 font-mono mt-1">via ${escapeHtml(m.quality_source)}</div>` : ''}
        </div>
        <div class="text-[10px] text-zinc-500 pt-2 border-t border-white/5">
          Context: ${this._contextBadge(m.context, m.context_source)} ${m.free ? '· FREE' : ''}
        </div>
      </div>`;
      })
      .join('')}</div>`;
  }

  _withScroll(fn) {
    const prev = this.listEl ? this.listEl.scrollTop : 0;
    fn();
    requestAnimationFrame(() => {
      if (this.listEl) this.listEl.scrollTop = prev;
    });
  }

  async addModel(id, provider, name) {
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    try {
      const res = await this.api.post('/model-discovery/add', {
        modelId: id,
        provider,
        modelName: name,
      });
      if (res && res.success) {
        ModelToast.show(`Installed ${name}`, 'success');
        this.cache.invalidateAll();
        if (!this.data.configured_models) this.data.configured_models = [];
        this.data.configured_models.push(`${provider}/${id}`);
        this._withScroll(() => this.renderList());
      } else {
        throw new Error(res.error || 'Failed to install');
      }
    } catch (err) {
      ModelToast.show(`Error installing: ${err.message}`, 'error');
    } finally {
      this.isSubmitting = false;
    }
  }

  async removeModel(id, provider) {
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    try {
      const res = await this.api.post('/model-discovery/remove', { modelId: id, provider });
      if (res && res.success) {
        ModelToast.show(`Removed ${id}`, 'success');
        this.cache.invalidateAll();
        if (this.data.configured_models) {
          const fullId = `${provider}/${id}`;
          this.data.configured_models = this.data.configured_models.filter(
            (m) => m !== fullId && m !== id,
          );
        }
        this._withScroll(() => this.renderList());
      } else {
        throw new Error(res.error || 'Failed to remove');
      }
    } catch (err) {
      ModelToast.show(`Error removing: ${err.message}`, 'error');
    } finally {
      this.isSubmitting = false;
    }
  }
}
