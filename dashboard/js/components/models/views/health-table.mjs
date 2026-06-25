import { escapeHtml } from '../../../utils/sanitize.mjs';
import { PROVIDER_LABELS } from '../../../limits.mjs';
import { ModelToast } from '../model-toast.mjs';
import { debounce, relativeTime, truncate } from '../../../utils/format.mjs';
import { icons } from '../icons.mjs';

export class HealthTableView {
  constructor(api, state, cache) {
    this.api = api;
    this.state = state;
    this.cache = cache;
    this._autoRefreshTimer = null;
    this._checkingModels = new Set();
    this._checkingAll = false;
    this._batchProgress = null;
  }

  async mount(container) {
    this.container = document.createElement('div');
    this.container.className = 'h-full flex flex-col gap-4';
    container.appendChild(this.container);

    this.filterText = this.state.get().filterText;
    this.statusFilter = this.state.get().statusFilter || 'all';
    this.viewMode = this.state.get().healthViewMode || 'table';

    this._renderStatic();
    this._attachListeners();
    await this.loadHealth();
    this.startRefresh();

    this.unsubscribe = this.state.subscribe((s) => {
      let needsUpdate = false;
      if (this.filterText !== s.filterText) {
        this.filterText = s.filterText;
        needsUpdate = true;
      }
      if (this.statusFilter !== (s.statusFilter || 'all')) {
        this.statusFilter = s.statusFilter || 'all';
        needsUpdate = true;
      }
      if (this.viewMode !== (s.healthViewMode || 'table')) {
        this.viewMode = s.healthViewMode || 'table';
        this._reRender();
        return;
      }
      if (needsUpdate) this.updateDOM();
    });
  }

  unmount() {
    this.stopRefresh();
    if (this.unsubscribe) this.unsubscribe();
  }

  _reRender() {
    this._renderStatic();
    this._attachListeners();
    this.updateDOM();
  }

  _renderStatic() {
    const autoChecksEnabled = this.state.get().autoChecksEnabled;
    const checkingAll = this._checkingAll;
    const vm = this.viewMode;

    this.container.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shrink-0">
        <div>
          <h1 class="text-xl font-bold text-white tracking-tight">Health Monitor</h1>
          <p class="text-sm text-zinc-400 mt-1">Run health checks on individual models</p>
        </div>
        <div class="flex items-center gap-2">
          <div class="mm-toggle ${autoChecksEnabled ? 'on' : ''}" id="auto-toggle" title="Auto health checks"></div>
          <span class="text-[11px] font-semibold ${autoChecksEnabled ? 'text-emerald-400' : 'text-zinc-500'}" id="auto-toggle-label">${autoChecksEnabled ? 'Auto On' : 'Auto Off'}</span>
          <div class="w-px h-5 bg-white/10 mx-1"></div>
          <button id="check-all-btn" class="px-4 py-2.5 bg-gradient-to-r from-primary to-accentBlue text-white font-semibold rounded-xl text-sm transition shadow-lg flex items-center gap-2 ${checkingAll ? 'opacity-70 cursor-not-allowed' : ''}" ${checkingAll ? 'disabled' : ''}>
            <span style="width:16px;height:16px">${checkingAll ? icons.spinner : icons.play}</span>
            <span>${checkingAll ? 'Running...' : 'Run All'}</span>
          </button>
        </div>
      </div>

      ${
        this._batchProgress !== null
          ? `
      <div class="shrink-0">
        <div class="mm-progress-track"><div class="mm-progress-fill" style="width:${this._batchProgress}%"></div></div>
        <div class="text-[11px] text-zinc-500 mt-1 font-mono">Checking... ${Math.round(this._batchProgress)}%</div>
      </div>`
          : ''
      }

      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0">
        <div class="flex flex-col sm:flex-row sm:items-center gap-4 w-full">
          <div class="relative flex-grow max-w-sm">
            <span class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <span style="width:16px;height:16px;color:#71717a">${icons.search}</span>
            </span>
            <input id="mm-search" type="text" placeholder="Search models or providers..." class="w-full pl-9 pr-4 py-2 bg-zinc-900/50 border border-white/5 rounded-xl text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-primary/50 transition" value="${escapeHtml(this.filterText)}">
          </div>

          <div class="flex items-center gap-2 flex-wrap" id="mm-filters">
            <button data-filter="all" class="mm-chip ${this.statusFilter === 'all' ? 'active' : ''}">All</button>
            <button data-filter="healthy" class="mm-chip ${this.statusFilter === 'healthy' ? 'active' : ''}"><span class="mm-status-dot healthy" style="width:6px;height:6px"></span> Healthy</button>
            <button data-filter="unhealthy" class="mm-chip ${this.statusFilter === 'unhealthy' ? 'active' : ''}"><span class="mm-status-dot unhealthy" style="width:6px;height:6px"></span> Unhealthy</button>
            <button data-filter="unchecked" class="mm-chip ${this.statusFilter === 'unchecked' ? 'active' : ''}">Unchecked</button>
            <button data-filter="deprecated" class="mm-chip ${this.statusFilter === 'deprecated' ? 'active' : ''}" style="border-color:rgba(245,158,11,0.2);color:#f59e0b">Deprecated</button>
          </div>
        </div>

        <div class="flex items-center gap-3 shrink-0">
          <span id="mm-total-count" class="text-xs font-medium text-zinc-400">0 models</span>
          <div class="flex items-center gap-1 bg-zinc-900/50 p-1 rounded-lg border border-white/5">
            <button data-vmode="table" class="p-1.5 rounded-md transition ${vm === 'table' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}" title="Table view">
              <span style="width:14px;height:14px;display:block">${icons.list}</span>
            </button>
            <button data-vmode="grid" class="p-1.5 rounded-md transition ${vm === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}" title="Card view">
              <span style="width:14px;height:14px;display:block">${icons.grid}</span>
            </button>
          </div>
          <button id="mm-export-btn" class="p-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-lg transition border border-white/5" title="Export JSON">
            <span style="width:14px;height:14px;display:block">${icons.export}</span>
          </button>
        </div>
      </div>

      <div id="mm-content-area" class="flex-grow min-h-0 overflow-x-auto overflow-y-auto custom-scrollbar">
      </div>
    `;

    this.contentArea = this.container.querySelector('#mm-content-area');
    this.totalCount = this.container.querySelector('#mm-total-count');
    this.searchInput = this.container.querySelector('#mm-search');
    this.autoToggle = this.container.querySelector('#auto-toggle');
    this.autoToggleLabel = this.container.querySelector('#auto-toggle-label');
    this.checkAllBtn = this.container.querySelector('#check-all-btn');
    this.filtersContainer = this.container.querySelector('#mm-filters');
    this.exportBtn = this.container.querySelector('#mm-export-btn');
  }

  _attachListeners() {
    this.searchInput.addEventListener(
      'input',
      debounce((e) => {
        this.state.update({ filterText: e.target.value });
      }, 250),
    );

    this.contentArea.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-check]');
      if (btn && !btn.disabled) this.checkOne(btn.getAttribute('data-check'));
      const errBtn = e.target.closest('.error-tooltip-btn');
      if (errBtn) ModelToast.show(errBtn.getAttribute('data-error'), 'error', 5000);
    });

    this.filtersContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      const filter = btn.getAttribute('data-filter');
      this.state.update({ statusFilter: filter });
      this.statusFilter = filter;
      this.filtersContainer
        .querySelectorAll('.mm-chip')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      this.updateDOM();
    });

    this.container.querySelectorAll('[data-vmode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.vmode;
        this.state.update({ healthViewMode: mode });
        this.viewMode = mode;
        this.container
          .querySelectorAll('[data-vmode]')
          .forEach((b) => b.classList.remove('bg-white/10', 'text-white'));
        this.container
          .querySelectorAll('[data-vmode]')
          .forEach((b) => b.classList.add('text-zinc-500'));
        btn.classList.add('bg-white/10', 'text-white');
        btn.classList.remove('text-zinc-500');
        this.updateDOM();
      });
    });

    this.exportBtn.addEventListener('click', () => this.exportData());
    this.checkAllBtn.addEventListener('click', () => this.checkAll());

    this.autoToggle.addEventListener('click', async () => {
      const current = this.state.get().autoChecksEnabled;
      try {
        const r = await this.api.post('/model-health/auto', { enabled: !current });
        if (r) {
          this.state.update({ autoChecksEnabled: r.enabled });
          this.autoToggle.classList.toggle('on', r.enabled);
          this.autoToggleLabel.textContent = r.enabled ? 'Auto On' : 'Auto Off';
          this.autoToggleLabel.className = `text-[11px] font-semibold ${r.enabled ? 'text-emerald-400' : 'text-zinc-500'}`;
          ModelToast.show(`Auto checks ${r.enabled ? 'enabled' : 'disabled'}`);
        }
      } catch {
        ModelToast.show('Failed to toggle auto-checks', 'error');
      }
    });

    this.contentArea.addEventListener('click', (e) => {
      const sortTh = e.target.closest('.mm-sort-th');
      if (sortTh) {
        const col = sortTh.dataset.sort;
        const current = this.state.get();
        this.state.update({
          sortCol: col,
          sortDesc: current.sortCol === col ? !current.sortDesc : false,
        });
        this.updateDOM();
      }
    });
  }

  async loadHealth(retries = 2) {
    const cached = this.cache.get('health_list');
    if (cached) {
      this.state.update({ healthList: cached.data, autoChecksEnabled: cached.auto });
      this.updateDOM();
      return;
    }
    try {
      const [d, a] = await Promise.all([
        this.api.get('/model-health').catch(() => null),
        this.api.get('/model-health/auto').catch(() => null),
      ]);
      if (d) {
        const autoEnabled = !!(a && a.enabled);
        this.state.update({ healthList: d, autoChecksEnabled: autoEnabled });
        this.cache.set('health_list', { data: d, auto: autoEnabled });
        this.updateDOM();
      }
    } catch {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 1000));
        return this.loadHealth(retries - 1);
      }
      ModelToast.show('Failed to load model health statuses', 'error');
    }
  }

  startRefresh() {
    this.stopRefresh();
    this._autoRefreshTimer = setInterval(() => this.loadHealth(1), 30000);
  }

  stopRefresh() {
    if (this._autoRefreshTimer) {
      clearInterval(this._autoRefreshTimer);
      this._autoRefreshTimer = null;
    }
  }

  async checkOne(id) {
    if (this._checkingModels.has(id)) return;
    this._checkingModels.add(id);
    this.updateDOM();
    try {
      const r = await this.api.post('/model-health/check', { model_id: id });
      if (r && r.success && r.data) {
        const list = this.state.get().healthList;
        const i = list.findIndex((m) => m.id === id);
        if (i !== -1) {
          list[i] = r.data;
          this.state.update({ healthList: [...list] });
          this.cache.invalidate('health_list');
        }
        ModelToast.show(
          `${r.data.actual_model}: ${r.data.health_status}`,
          r.data.health_status === 'healthy' ? 'success' : 'error',
        );
      }
    } catch (e) {
      ModelToast.show(`Check error: ${e.message}`, 'error');
    } finally {
      this._checkingModels.delete(id);
      this.updateDOM();
    }
  }

  async checkAll() {
    if (this._checkingAll) return;
    this._checkingAll = true;
    this._batchProgress = 0;
    this._renderStatic();
    this._attachListeners();
    this.updateDOM();

    const list = this.state.get().healthList || [];

    try {
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        this._batchProgress = ((i + 1) / list.length) * 100;
        this._renderStatic();
        this._attachListeners();

        try {
          await this.api.post('/model-health/check', { model_id: m.id });
        } catch {
          /* continue */
        }
      }
      this.cache.invalidate('health_list');
      await this.loadHealth(0);
      ModelToast.show('All checks completed', 'success');
    } catch {
      ModelToast.show('Error running checks', 'error');
    } finally {
      this._checkingAll = false;
      this._batchProgress = null;
      this._expandedProviders = null;
      this._renderStatic();
      this._attachListeners();
      this.updateDOM();
    }
  }

  exportData() {
    const list = this.state.get().healthList || [];
    if (!list.length) return ModelToast.show('No data to export', 'error');
    const dataStr =
      'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(list, null, 2));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', 'model_health_export.json');
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  _getFilteredSorted() {
    const list = this.state.get().healthList || [];
    const q = this.filterText.toLowerCase().trim();
    const status = this.statusFilter;
    const sortCol = this.state.get().sortCol;
    const sortDesc = this.state.get().sortDesc;

    const filtered = list.filter((m) => {
      if (status !== 'all' && m.health_status !== status) return false;
      if (!q) return true;
      return (
        (m.actual_model || '').toLowerCase().includes(q) ||
        (m.provider || '').toLowerCase().includes(q) ||
        (m.aliases || []).some((a) => a.toLowerCase().includes(q))
      );
    });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      const hMap = { healthy: 0, unchecked: 1, unhealthy: 2, deprecated: 3 };
      if (sortCol === 'actual_model') {
        const c = (a.actual_model || '').localeCompare(b.actual_model || '');
        return sortDesc ? -c : c;
      }
      if (sortCol === 'health_status') {
        const ha = hMap[a.health_status] ?? 2,
          hb = hMap[b.health_status] ?? 2;
        return sortDesc ? hb - ha : ha - hb;
      }
      if (sortCol === 'provider') {
        const c = (a.provider || '').localeCompare(b.provider || '');
        return sortDesc ? -c : c;
      }
      if (sortCol === 'failure_streak') {
        return sortDesc
          ? (b.failure_streak || 0) - (a.failure_streak || 0)
          : (a.failure_streak || 0) - (b.failure_streak || 0);
      }
      if (sortCol === 'last_check') {
        return sortDesc
          ? (b.last_check || '').localeCompare(a.last_check || '')
          : (a.last_check || '').localeCompare(b.last_check || '');
      }
      const hOrder = hMap[a.health_status] ?? 2;
      const hbOrder = hMap[b.health_status] ?? 2;
      if (hOrder !== hbOrder) return hOrder - hbOrder;
      return (b.failure_streak || 0) - (a.failure_streak || 0);
    });

    return sorted;
  }

  updateDOM() {
    const filtered = this._getFilteredSorted();
    this.totalCount.textContent = `${filtered.length} model${filtered.length !== 1 ? 's' : ''}`;

    if (this.viewMode === 'grid') {
      this._renderGrid(filtered);
    } else {
      this._renderTable(filtered);
    }
  }

  _renderTable(models) {
    const sortCol = this.state.get().sortCol;
    const sortDesc = this.state.get().sortDesc;
    const checkingAll = this._checkingAll;
    const sortIcon = (col) => {
      if (sortCol !== col) return '';
      return `<span style="width:12px;height:12px;display:inline-block;opacity:0.6">${sortDesc ? icons.arrowDown : icons.arrowUp}</span>`;
    };

    const providers = this._groupByProvider(models);

    let html = `<table class="w-full text-left border-collapse min-w-max">
      <thead class="sticky top-0 z-10">
        <tr class="bg-zinc-900/90 backdrop-blur border-b border-white/5 text-zinc-400 text-xs font-semibold uppercase tracking-wider">
          <th class="mm-sort-th py-3 px-4 ${sortCol === 'actual_model' ? 'active' : ''}" data-sort="actual_model">Model ${sortIcon('actual_model')}</th>
          <th class="mm-sort-th py-3 px-4 ${sortCol === 'provider' ? 'active' : ''}" data-sort="provider">Provider ${sortIcon('provider')}</th>
          <th class="mm-sort-th py-3 px-4 text-center ${sortCol === 'health_status' ? 'active' : ''}" data-sort="health_status">Health ${sortIcon('health_status')}</th>
          <th class="py-3 px-4">Error</th>
          <th class="mm-sort-th py-3 px-4 ${sortCol === 'last_check' ? 'active' : ''}" data-sort="last_check">Last Check ${sortIcon('last_check')}</th>
          <th class="mm-sort-th py-3 px-4 text-center ${sortCol === 'failure_streak' ? 'active' : ''}" data-sort="failure_streak">Failures ${sortIcon('failure_streak')}</th>
          <th class="py-3 px-4 text-center">Action</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-white/[0.02] text-sm">`;

    if (models.length === 0) {
      html += `<tr><td colspan="7" class="text-center py-12 text-zinc-500 text-sm">No models found.</td></tr>`;
    } else {
      for (const [provider, provModels] of providers) {
        const pl =
          PROVIDER_LABELS[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
        const provKey = `ht-prov-${provider}`;
        const isExpanded = this._expandedProviders == null || this._expandedProviders.has(provider);
        html += `<tr class="bg-white/[0.02] border-y border-white/5 cursor-pointer ht-prov-header" data-prov-key="${provKey}">
          <td colspan="8" class="py-2.5 px-4">
            <div class="flex items-center gap-2">
              <span class="mm-collapse-arrow ${isExpanded ? 'open' : ''}" style="width:14px;height:14px;color:#71717a">${icons.chevronRight}</span>
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20">${escapeHtml(pl)}</span>
              <span class="text-[10px] text-zinc-500 font-mono">${provModels.length}</span>
            </div>
          </td>
        </tr>`;
        for (const m of provModels) {
          html += this._createModelRow(m, checkingAll, provKey, isExpanded);
        }
      }
    }

    html += `</tbody></table>`;
    this.contentArea.innerHTML = html;

    this.contentArea.querySelectorAll('.ht-prov-header').forEach((header) => {
      header.addEventListener('click', () => {
        const key = header.dataset.provKey;
        const arrow = header.querySelector('.mm-collapse-arrow');
        const rows = this.contentArea.querySelectorAll(`[data-prov-row="${key}"]`);
        const provider = key.replace('ht-prov-', '');
        rows.forEach((r) => r.classList.toggle('hidden'));
        arrow.classList.toggle('open');
        if (!this._expandedProviders) this._expandedProviders = new Set();
        if (rows[0]?.classList.contains('hidden')) {
          this._expandedProviders.delete(provider);
        } else {
          this._expandedProviders.add(provider);
        }
      });
    });
  }

  _groupByProvider(models) {
    const map = new Map();
    for (const m of models) {
      const p = m.provider || 'unknown';
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(m);
    }
    return map;
  }

  _createModelRow(m, checkingAll, provKey, isExpanded) {
    const isChecking = this._checkingModels.has(m.id);
    const statusClass = m.health_status || 'unchecked';

    let badge = `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium
      bg-${statusClass === 'healthy' ? 'emerald' : statusClass === 'unhealthy' ? 'rose' : statusClass === 'deprecated' ? 'amber' : 'zinc'}-500/10
      text-${statusClass === 'healthy' ? 'emerald' : statusClass === 'unhealthy' ? 'rose' : statusClass === 'deprecated' ? 'amber' : 'zinc'}-400
      border border-${statusClass === 'healthy' ? 'emerald' : statusClass === 'unhealthy' ? 'rose' : statusClass === 'deprecated' ? 'amber' : 'zinc'}-500/20">
      <span class="mm-status-dot ${statusClass}" style="width:6px;height:6px"></span>${statusClass}</span>`;

    const ec = m.health_status === 'unhealthy' ? 'text-rose-400 font-medium' : 'text-zinc-500';
    let et = m.error_details || '';
    if (et.length > 25) {
      et = `<div class="flex items-center gap-1.5 group cursor-pointer error-tooltip-btn" data-error="${escapeHtml(et)}">
        <span>${escapeHtml(truncate(et, 25))}</span>
        <span style="width:10px;height:10px;opacity:0.3">${icons.info}</span>
      </div>`;
    } else {
      et = escapeHtml(et);
    }

    const lastCheck = m.last_check ? relativeTime(m.last_check) : '';
    let failuresHtml = '<span class="text-zinc-500 text-xs">-</span>';
    if (m.health_status === 'healthy') {
      failuresHtml = '<span class="text-emerald-400 text-xs font-semibold">0</span>';
    } else if (m.failure_streak > 0) {
      const streak = m.failure_streak;
      const pct = Math.min(100, (streak / 10) * 100);
      const color = streak > 5 ? 'bg-rose-500' : streak > 2 ? 'bg-amber-500' : 'bg-yellow-500';
      failuresHtml = `<div class="flex flex-col items-center gap-1 w-full px-2" title="${streak} failures">
        <span class="${streak > 5 ? 'text-rose-400' : 'text-amber-400'} text-[10px] font-bold">${streak}x</span>
        <div class="w-12 h-1 bg-zinc-800 rounded-full overflow-hidden"><div class="h-full ${color}" style="width:${pct}%"></div></div>
      </div>`;
    }

    const tr = document.createElement('tr');
    tr.className = `hover:bg-white/[0.01] transition-colors ${provKey && !isExpanded ? 'hidden' : ''}`;
    if (provKey) tr.dataset.provRow = provKey;
    tr.innerHTML = `
      <td class="py-3 px-4 font-mono text-xs"><span class="bg-zinc-900/40 text-zinc-300 border border-white/5 px-2 py-0.5 rounded-lg select-all font-semibold">${escapeHtml(m.actual_model)}</span></td>
      <td class="py-3 px-4 text-xs text-zinc-400">${escapeHtml(m.provider || 'unknown')}</td>
      <td class="py-3 px-4 text-center">${badge}</td>
      <td class="py-3 px-4 font-mono text-xs ${ec}">${et}</td>
      <td class="py-3 px-4 text-zinc-400 text-xs" title="${escapeHtml(m.last_check || '')}">${escapeHtml(lastCheck)}</td>
      <td class="py-3 px-4 text-center">${failuresHtml}</td>
      <td class="py-3 px-4 text-center">
        <button data-check="${m.id}" class="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition disabled:opacity-50" ${isChecking || checkingAll ? 'disabled' : ''} title="Run check">
          <span style="width:16px;height:16px;display:block" class="${isChecking ? 'mm-spin' : ''}">${isChecking ? icons.spinner : icons.play}</span>
        </button>
      </td>`;
    return tr.outerHTML;
  }

  _renderGrid(models) {
    if (models.length === 0) {
      this.contentArea.innerHTML = `<div class="mm-empty-state"><div class="es-icon">${icons.server}</div><p class="text-sm">No models found.</p></div>`;
      return;
    }

    const providers = this._groupByProvider(models);
    const checkingAll = this._checkingAll;

    let html = '<div class="space-y-3 p-1">';
    for (const [provider, provModels] of providers) {
      const pl = PROVIDER_LABELS[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
      const isExpanded = this._expandedProviders == null || this._expandedProviders.has(provider);
      html += `
        <div class="glass-panel p-0 overflow-hidden">
          <button class="ht-prov-header flex items-center justify-between w-full px-4 py-3 bg-white/[0.02] border-b border-white/5 hover:bg-white/[0.04] transition cursor-pointer" data-prov="${escapeHtml(provider)}">
            <div class="flex items-center gap-3">
              <span class="mm-collapse-arrow ${isExpanded ? 'open' : ''}" style="width:14px;height:14px;color:#71717a">${icons.chevronRight}</span>
              <span class="text-xs font-semibold text-white">${escapeHtml(pl)}</span>
              <span class="text-[10px] font-mono text-zinc-500 bg-white/[0.03] px-2 py-0.5 rounded">${provModels.length}</span>
            </div>
          </button>
          <div class="ht-prov-body ${isExpanded ? '' : 'hidden'}" data-prov-body="${escapeHtml(provider)}">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-3">${provModels
              .map((m) => {
                const isChecking = this._checkingModels.has(m.id);
                const statusClass = m.health_status || 'unchecked';

                let failHtml = '';
                if (m.failure_streak > 0) {
                  const color = m.failure_streak > 5 ? '#f43f5e' : '#f59e0b';
                  failHtml = `<span class="text-[10px] font-bold" style="color:${color}">${m.failure_streak}x fail</span>`;
                }

                const lastCheck = m.last_check ? relativeTime(m.last_check) : 'Never';

                return `<div class="mm-health-card ${statusClass}">
                  <div class="flex items-start justify-between gap-2 mb-2">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="mm-status-dot ${statusClass}"></span>
                      <span class="text-xs font-mono font-semibold text-white truncate">${escapeHtml(m.actual_model)}</span>
                    </div>
                    <button data-check="${m.id}" class="p-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition disabled:opacity-50 flex-shrink-0" ${isChecking || checkingAll ? 'disabled' : ''} title="Run check">
                      <span style="width:14px;height:14px;display:block" class="${isChecking ? 'mm-spin' : ''}">${isChecking ? icons.spinner : icons.play}</span>
                    </button>
                  </div>
                  <div class="flex items-center justify-between text-[10px] text-zinc-500 mt-auto pt-2 border-t border-white/[0.03]">
                    <span>${escapeHtml(pl)}</span>
                    <span>${escapeHtml(lastCheck)}</span>
                    ${failHtml}
                  </div>
                  ${m.error_details ? `<div class="text-[10px] text-rose-400 truncate mt-1 font-mono">${escapeHtml(truncate(m.error_details, 40))}</div>` : ''}
                </div>`;
              })
              .join('')}</div>
          </div>
        </div>`;
    }
    html += '</div>';

    this.contentArea.innerHTML = html;

    this.contentArea.querySelectorAll('.ht-prov-header').forEach((header) => {
      header.addEventListener('click', () => {
        const prov = header.dataset.prov;
        const body = this.contentArea.querySelector(`[data-prov-body="${prov}"]`);
        const arrow = header.querySelector('.mm-collapse-arrow');
        if (body) {
          body.classList.toggle('hidden');
          arrow.classList.toggle('open');
          if (!this._expandedProviders) this._expandedProviders = new Set();
          if (body.classList.contains('hidden')) {
            this._expandedProviders.delete(prov);
          } else {
            this._expandedProviders.add(prov);
          }
        }
      });
    });
  }
}
