import { escapeHtml } from '../../utils/sanitize.js';
import { ModelState } from './model-state.js';
import { ModelCache } from './model-cache.js';
import { ModelToast } from './model-toast.js';
import { icons } from './icons.js';

const views = {
  overview: () => import('./views/overview.js').then((m) => m.OverviewView),
  all: () => import('./views/health-table.js').then((m) => m.HealthTableView),
  add: () => import('./views/add-model.js').then((m) => m.AddModelView),
  creds: () => import('./views/credentials.js').then((m) => m.CredentialsView),
  endpoints: () => import('./views/endpoints.js').then((m) => m.EndpointsView),
  retry: () => import('./views/retry-settings.js').then((m) => m.RetrySettingsView),
  alias: () => import('./views/aliases.js').then((m) => m.AliasesView),
  disc: () => import('./views/discovery.js').then((m) => m.DiscoveryView),
};

const NAV_GROUPS = [
  {
    label: 'Dashboard',
    items: [{ id: 'overview', icon: 'dashboard', label: 'Overview' }],
  },
  {
    label: 'Models',
    items: [
      {
        id: 'all',
        icon: 'server',
        label: 'Health Monitor',
        badgeKey: 'unhealthy',
        badgeType: 'unhealthy',
      },
      { id: 'add', icon: 'plus', label: 'Add Model' },
      { id: 'disc', icon: 'compass', label: 'Discovery' },
    ],
  },
  {
    label: 'Routing',
    items: [
      { id: 'alias', icon: 'tags', label: 'Fallback Chains' },
      { id: 'retry', icon: 'refresh', label: 'Retry Policy' },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { id: 'creds', icon: 'key', label: 'Credentials' },
      { id: 'endpoints', icon: 'network', label: 'Endpoints' },
    ],
  },
];

const CMD_PALETTE_ITEMS = [
  { id: 'overview', icon: 'dashboard', label: 'Go to Overview', shortcut: '1' },
  { id: 'all', icon: 'server', label: 'Go to Health Monitor', shortcut: '2' },
  { id: 'add', icon: 'plus', label: 'Add New Model', shortcut: '3' },
  { id: 'disc', icon: 'compass', label: 'Model Discovery', shortcut: '4' },
  { id: 'alias', icon: 'tags', label: 'Fallback Chains', shortcut: '5' },
  { id: 'retry', icon: 'refresh', label: 'Retry Policy', shortcut: '6' },
  { id: 'creds', icon: 'key', label: 'Credentials', shortcut: '7' },
  { id: 'endpoints', icon: 'network', label: 'Endpoints', shortcut: '8' },
  { id: 'reload', icon: 'download', label: 'Reload Price Data' },
];

export class ModelManagement {
  [key: string]: any;
  constructor(container, appState, api) {
    this.container = container;
    this.appState = appState;
    this.api = api;

    this.state = new ModelState();
    this.cache = new ModelCache();

    this.currentViewId = null;
    this.currentViewInstance = null;
    this.viewInstances = new Map();

    this.unsubscribe = this.state.subscribe(this.onStateChange.bind(this));
    this._cmdPaletteEl = null;
    this._cmdSelectedIdx = 0;
    this._boundCmdKeydown = this._onCmdKeydown.bind(this);
  }

  async mount() {
    const collapsed = this.state.get().sidebarCollapsed;
    this.container.innerHTML = `
      <div class="h-full flex flex-col md:flex-row gap-4 p-2 md:p-4">
        <div class="w-full md:w-56 flex-shrink-0 transition-all duration-300 ${collapsed ? 'md:w-14' : ''}" id="mm-sidebar-wrap">
          <div class="glass-panel p-3 h-full flex flex-col gap-1 overflow-hidden" id="mm-nav">
          </div>
        </div>
        <div class="flex-grow flex flex-col min-h-0">
          <div class="glass-panel p-6 h-full flex flex-col relative overflow-hidden" id="mm-content">
          </div>
        </div>
      </div>
    `;

    this.navContainer = this.container.querySelector('#mm-nav');
    this.contentContainer = this.container.querySelector('#mm-content');
    this.sidebarWrap = this.container.querySelector('#mm-sidebar-wrap');

    this.renderNav();

    this.navContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn) return;
      const viewId = btn.dataset.view;
      if (viewId === 'reload') {
        this.handlePriceReload(btn);
      } else if (viewId === 'collapse') {
        this._toggleSidebar();
      } else {
        this.state.update({ activeView: viewId });
      }
    });

    document.addEventListener('keydown', this._boundCmdKeydown);

    await this.switchView(this.state.get().activeView);
  }

  unmount() {
    if (this.unsubscribe) this.unsubscribe();
    if (this.currentViewInstance && this.currentViewInstance.unmount) {
      this.currentViewInstance.unmount();
    }
    document.removeEventListener('keydown', this._boundCmdKeydown);
    this._closeCmdPalette();
    this.container.innerHTML = '';
  }

  _onCmdKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      this._openCmdPalette();
      return;
    }
    if (e.key === 'Escape' && this._cmdPaletteEl) {
      this._closeCmdPalette();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 8) {
        e.preventDefault();
        const item = CMD_PALETTE_ITEMS[num - 1];
        if (item) {
          if (item.id === 'reload') {
            this.handlePriceReload(null);
          } else {
            this.state.update({ activeView: item.id });
          }
        }
      }
    }
  }

  _openCmdPalette() {
    if (this._cmdPaletteEl) {
      this._closeCmdPalette();
      return;
    }
    this._cmdSelectedIdx = 0;

    const overlay = document.createElement('div');
    overlay.className = 'mm-cmdk-overlay';
    overlay.innerHTML = `
      <div class="mm-cmdk-panel">
        <input class="mm-cmdk-input" placeholder="Search views, actions..." id="mm-cmdk-input" autofocus>
        <div class="mm-cmdk-list" id="mm-cmdk-list"></div>
        <div class="px-4 py-3 border-t border-white/5 flex items-center gap-4 text-[11px] text-zinc-500">
          <span><kbd class="px-1.5 py-0.5 bg-white/5 rounded text-zinc-400 font-mono">↑↓</kbd> Navigate</span>
          <span><kbd class="px-1.5 py-0.5 bg-white/5 rounded text-zinc-400 font-mono">↵</kbd> Select</span>
          <span><kbd class="px-1.5 py-0.5 bg-white/5 rounded text-zinc-400 font-mono">Esc</kbd> Close</span>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this._cmdPaletteEl = overlay;

    const input = overlay.querySelector('#mm-cmdk-input');
    const list = overlay.querySelector('#mm-cmdk-list');

    const cmdInput = input as HTMLInputElement;
    this._renderCmdItems(list, cmdInput.value);
    cmdInput.focus();

    cmdInput.addEventListener('input', () => {
      this._cmdSelectedIdx = 0;
      this._renderCmdItems(list, cmdInput.value);
    });

    cmdInput.addEventListener('keydown', (e: KeyboardEvent) => {
      const items = list!.querySelectorAll('.mm-cmdk-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._cmdSelectedIdx = Math.min(this._cmdSelectedIdx + 1, items.length - 1);
        this._highlightCmdItem(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._cmdSelectedIdx = Math.max(this._cmdSelectedIdx - 1, 0);
        this._highlightCmdItem(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const sel = items[this._cmdSelectedIdx] as HTMLElement;
        if (sel) sel.click();
      }
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._closeCmdPalette();
    });
  }

  _closeCmdPalette() {
    if (this._cmdPaletteEl) {
      this._cmdPaletteEl.remove();
      this._cmdPaletteEl = null;
    }
  }

  _renderCmdItems(list, query) {
    const q = (query || '').toLowerCase().trim();
    const filtered = q
      ? CMD_PALETTE_ITEMS.filter((i) => i.label.toLowerCase().includes(q))
      : CMD_PALETTE_ITEMS;

    list.innerHTML = filtered
      .map(
        (item, i) => `
      <div class="mm-cmdk-item ${i === this._cmdSelectedIdx ? 'selected' : ''}" data-cmd-id="${item.id}">
        <span class="mm-cmdk-icon">${icons[item.icon] || ''}</span>
        <span>${escapeHtml(item.label)}</span>
        ${item.shortcut ? `<span class="mm-cmdk-shortcut">⌘${item.shortcut}</span>` : ''}
      </div>
    `,
      )
      .join('');

    list.querySelectorAll('.mm-cmdk-item').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.cmdId;
        this._closeCmdPalette();
        if (id === 'reload') {
          this.handlePriceReload(null);
        } else {
          this.state.update({ activeView: id });
        }
      });
      el.addEventListener('mouseenter', () => {
        const items = list.querySelectorAll('.mm-cmdk-item');
        this._cmdSelectedIdx = Array.from(items).indexOf(el);
        this._highlightCmdItem(items);
      });
    });
  }

  _highlightCmdItem(items) {
    items.forEach((el, i) => el.classList.toggle('selected', i === this._cmdSelectedIdx));
  }

  _toggleSidebar() {
    const collapsed = !this.state.get().sidebarCollapsed;
    this.state.update({ sidebarCollapsed: collapsed });
    if (collapsed) {
      this.sidebarWrap.classList.add('md:w-14');
      this.sidebarWrap.classList.remove('md:w-56');
    } else {
      this.sidebarWrap.classList.remove('md:w-14');
      this.sidebarWrap.classList.add('md:w-56');
    }
    this.renderNav();
  }

  onStateChange(newState) {
    if (newState.activeView !== this.currentViewId) {
      this.renderNav();
      this.switchView(newState.activeView);
    }
    if (newState.healthList) {
      this._updateNavBadges();
    }
  }

  async switchView(viewId) {
    if (!views[viewId]) viewId = 'overview';
    if (this.currentViewId === viewId) return;

    if (this.currentViewInstance) {
      if (this.currentViewInstance.unmount) this.currentViewInstance.unmount();
      this.contentContainer.innerHTML = '';
    }

    this.currentViewId = viewId;

    try {
      this.contentContainer.innerHTML = `
        <div class="flex items-center justify-center h-full">
          <div class="mm-spin" style="width:32px;height:32px;color:#8b5cf6">${icons.spinner}</div>
        </div>
      `;

      let viewInstance = this.viewInstances.get(viewId);
      if (!viewInstance) {
        const ViewClass = await views[viewId]();
        viewInstance = new ViewClass(this.api, this.state, this.cache);
        this.viewInstances.set(viewId, viewInstance);
      }

      this.currentViewInstance = viewInstance;
      this.contentContainer.innerHTML = '';

      const viewContainer = document.createElement('div');
      viewContainer.className = 'h-full flex flex-col min-h-0 mm-view-enter';
      this.contentContainer.appendChild(viewContainer);

      await viewInstance.mount(viewContainer);
    } catch (err) {
      console.error('[ModelManagement] Failed to switch view:', err);
      this.contentContainer.innerHTML = `
        <div class="flex items-center justify-center h-full text-red-400 p-4 text-center">
          <div>
            <div style="width:48px;height:48px;margin:0 auto 12px;opacity:0.5">${icons.zap}</div>
            <p class="font-medium">Failed to load view</p>
            <p class="text-xs text-zinc-500 mt-1">${escapeHtml(err.message)}</p>
          </div>
        </div>
      `;
    }
  }

  renderNav() {
    const v = this.state.get().activeView;
    const collapsed = this.state.get().sidebarCollapsed;
    const stats = this.state.getStats();

    let html = '';

    html += `<button data-view="collapse" class="mm-nav-item mb-2" title="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}">
      <span class="mm-nav-icon" style="width:18px;height:18px">${icons.sidebar}</span>
      ${!collapsed ? '<span class="font-medium text-xs text-zinc-500 ml-1">Navigator</span>' : ''}
      <span class="ml-auto text-[10px] text-zinc-600 font-mono">${!collapsed ? '⌘K' : ''}</span>
    </button>`;

    for (const group of NAV_GROUPS) {
      if (!collapsed) {
        html += `<div class="mm-nav-group-label">${escapeHtml(group.label)}</div>`;
      }
      for (const item of group.items) {
        const isActive = v === item.id;
        let badgeHtml = '';
        if (item.badgeKey && stats[item.badgeKey] > 0) {
          badgeHtml = `<span class="mm-nav-badge ${item.badgeType}">${stats[item.badgeKey]}</span>`;
        }
        html += `<button data-view="${item.id}" class="mm-nav-item ${isActive ? 'active' : ''}" title="${item.label}">
          <span class="mm-nav-icon" style="width:18px;height:18px">${icons[item.icon] || ''}</span>
          ${!collapsed ? `<span class="font-medium truncate">${escapeHtml(item.label)}</span>` : ''}
          ${!collapsed ? badgeHtml : ''}
        </button>`;
      }
    }

    if (!collapsed) {
      html += `<div class="mm-nav-group-label">Actions</div>`;
      html += `<button data-view="reload" class="mm-nav-item" title="Reload Price Data">
        <span class="mm-nav-icon" style="width:18px;height:18px">${icons.download}</span>
        <span class="font-medium truncate">Price Reload</span>
      </button>`;
    } else {
      html += `<button data-view="reload" class="mm-nav-item" title="Reload Price Data">
        <span class="mm-nav-icon" style="width:18px;height:18px">${icons.download}</span>
      </button>`;
    }

    this.navContainer.innerHTML = html;
  }

  _updateNavBadges() {
    const stats = this.state.getStats();
    this.navContainer.querySelectorAll('.mm-nav-badge').forEach((el) => {
      const btn = el.closest('[data-view]');
      if (!btn) return;
      const viewId = btn.dataset.view;
      const group = NAV_GROUPS.find((g) => g.items.some((i) => i.id === viewId));
      if (!group) return;
      const item = group.items.find((i) => i.id === viewId);
      if (!item || !item.badgeKey) return;
      const val = stats[item.badgeKey] || 0;
      el.textContent = val;
      el.style.display = val > 0 ? '' : 'none';
    });
  }

  async handlePriceReload(_btn?: any) {
    ModelToast.show('Reloading price data...', 'info', 2000);
    try {
      const res = await this.api.post('/model-price-reload');
      if (res && res.success) {
        if (res.simulated) {
          ModelToast.show('Price Reload simulated (LiteLLM unreachable)', 'info');
        } else {
          ModelToast.show('Price Data Reload successful', 'success');
        }
      } else {
        throw new Error(res.error || 'Unknown error');
      }
    } catch (e) {
      ModelToast.show('Failed to reload prices: ' + e.message, 'error');
    }
  }
}

export function mountModels(container, appState, api) {
  const mm = new ModelManagement(container, appState, api);
  mm.mount();
}
