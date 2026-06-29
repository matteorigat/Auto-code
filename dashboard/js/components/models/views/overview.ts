import { escapeHtml } from '../../../utils/sanitize.js';
import { PROVIDER_LABELS } from '../../../limits.js';
import { ModelToast } from '../model-toast.js';
import { icons } from '../icons.js';

const PROVIDER_COLORS = {
  opencode: '#8b5cf6',
  opencode_zen: '#8b5cf6',
  openrouter: '#f59e0b',
  groq: '#10b981',
  mistral: '#3b82f6',
  kilo: '#ec4899',
  cerebras: '#06b6d4',
  nvidia: '#84cc16',
  modal: '#f43f5e',
  google: '#eab308',
  openai: '#10b981',
  unknown: '#71717a',
};

export class OverviewView {
  [key: string]: any;
  constructor(api, state, cache) {
    this.api = api;
    this.state = state;
    this.cache = cache;
    this._autoRefreshTimer = null;
    this._prevStats = null;
  }

  async mount(container) {
    this.container = document.createElement('div');
    this.container.className = 'h-full flex flex-col gap-6 overflow-y-auto custom-scrollbar';
    container.appendChild(this.container);

    this._render();
    this._attachListeners();
    await this.loadData();
    this.startRefresh();

    this.unsubscribe = this.state.subscribe((s) => {
      if (s.healthList !== this._prevList) {
        this._prevList = s.healthList;
        this._updateCards();
        this._renderProviderRing();
      }
    });
  }

  unmount() {
    this.stopRefresh();
    if (this.unsubscribe) this.unsubscribe();
  }

  startRefresh() {
    this.stopRefresh();
    this._autoRefreshTimer = setInterval(() => this.loadData(1), 30000);
  }

  stopRefresh() {
    if (this._autoRefreshTimer) {
      clearInterval(this._autoRefreshTimer);
      this._autoRefreshTimer = null;
    }
  }

  _render() {
    this.container.innerHTML = `
      <div class="shrink-0">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-bold text-white tracking-tight">Model Management Overview</h1>
            <p class="text-sm text-zinc-400 mt-1">Real-time health and configuration at a glance</p>
          </div>
          <div class="flex items-center gap-2">
            <span id="ov-last-refresh" class="text-[11px] text-zinc-500 font-mono"></span>
            <button id="ov-refresh-btn" class="p-2 rounded-lg bg-zinc-800/50 border border-white/5 text-zinc-400 hover:text-white hover:border-white/10 transition" title="Refresh now">
              <span style="width:16px;height:16px;display:block">${icons.refresh}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 shrink-0" id="ov-stat-cards"></div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 flex-grow min-h-0">
        <div class="glass-panel p-5 flex flex-col items-center justify-center" id="ov-provider-ring">
          <div class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4 self-start">Provider Distribution</div>
          <div class="relative" style="width:180px;height:180px" id="ov-ring-container"></div>
          <div id="ov-ring-legend" class="flex flex-wrap gap-3 mt-4 justify-center"></div>
        </div>

        <div class="glass-panel p-5 flex flex-col" id="ov-quick-actions">
          <div class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Quick Actions</div>
          <div class="space-y-3 flex-grow" id="ov-qa-list"></div>
        </div>
      </div>
    `;
  }

  _attachListeners() {
    this.container
      .querySelector('#ov-refresh-btn')
      .addEventListener('click', () => this.loadData(0));
  }

  async loadData(retries = 2) {
    const cached = this.cache.get('health_list');
    if (cached) {
      this.state.update({ healthList: cached.data, autoChecksEnabled: cached.auto });
      this._updateCards();
      this._renderProviderRing();
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
        this._updateCards();
        this._renderProviderRing();
      }
    } catch {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 1000));
        return this.loadData(retries - 1);
      }
      ModelToast.show('Failed to load health data', 'error');
    } finally {
      const now = new Date();
      const el = this.container.querySelector('#ov-last-refresh');
      if (el) el.textContent = now.toLocaleTimeString('en-US', { hour12: false });
    }
  }

  _updateCards() {
    const stats = this.state.getStats();
    const el = this.container.querySelector('#ov-stat-cards');
    if (!el) return;

    const cards = [
      {
        label: 'Total Models',
        value: stats.total,
        icon: 'server',
        color: 'purple',
        sub: 'Configured',
      },
      {
        label: 'Healthy',
        value: stats.healthy,
        icon: 'heart',
        color: 'emerald',
        sub: stats.total ? `${Math.round((stats.healthy / stats.total) * 100)}% uptime` : '-',
      },
      {
        label: 'Unhealthy',
        value: stats.unhealthy,
        icon: 'zap',
        color: 'rose',
        sub: stats.unhealthy > 0 ? 'Needs attention' : 'All clear',
      },
      {
        label: 'Unchecked',
        value: stats.unchecked,
        icon: 'shield',
        color: 'blue',
        sub: 'Pending check',
      },
    ];

    el.innerHTML = cards
      .map((c) => {
        const colorMap = {
          purple: '#8b5cf6',
          emerald: '#10b981',
          rose: '#f43f5e',
          blue: '#3b82f6',
          amber: '#f59e0b',
        };
        return `
        <div class="mm-stat-card ${c.color}">
          <div class="flex items-center justify-between mb-3">
            <div class="p-2 rounded-lg" style="background:${colorMap[c.color]}15">
              <span style="width:20px;height:20px;display:block;color:${colorMap[c.color]}">${icons[c.icon] || ''}</span>
            </div>
            <span class="text-2xl font-bold text-white">${c.value}</span>
          </div>
          <div class="text-xs font-semibold text-zinc-400">${c.label}</div>
          <div class="text-[10px] text-zinc-500 mt-0.5">${c.sub}</div>
        </div>
      `;
      })
      .join('');

    const qaList = this.container.querySelector('#ov-qa-list');
    if (qaList) {
      const qas = [
        { id: 'all', label: 'Run Health Checks', desc: 'Check all model endpoints', icon: 'play' },
        { id: 'add', label: 'Add New Model', desc: 'Configure and deploy a model', icon: 'plus' },
        {
          id: 'disc',
          label: 'Browse Discovery',
          desc: 'Explore available models',
          icon: 'compass',
        },
        { id: 'alias', label: 'Manage Fallbacks', desc: 'Edit tier fallback chains', icon: 'tags' },
        {
          id: 'retry',
          label: 'Adjust Retry Policy',
          desc: 'Configure cooldown and retries',
          icon: 'refresh',
        },
      ];
      qaList.innerHTML = qas
        .map(
          (q) => `
        <button data-qa-nav="${q.id}" class="mm-quick-action">
          <span class="qa-icon" style="width:18px;height:18px">${icons[q.icon] || ''}</span>
          <div>
            <div class="font-semibold">${q.label}</div>
            <div class="text-[11px] text-zinc-500">${q.desc}</div>
          </div>
          <span class="ml-auto" style="width:14px;height:14px;opacity:0.3">${icons.chevronRight}</span>
        </button>
      `,
        )
        .join('');

      qaList.querySelectorAll('[data-qa-nav]').forEach((btn) => {
        btn.addEventListener('click', () => this.state.update({ activeView: btn.dataset.qaNav }));
      });
    }
  }

  _renderProviderRing() {
    const stats = this.state.getStats();
    const container = this.container.querySelector('#ov-ring-container');
    const legend = this.container.querySelector('#ov-ring-legend');
    if (!container || !legend) return;

    const providers = Object.entries(stats.providers) as [string, number][];
    if (!providers.length) {
      container.innerHTML = '<div class="text-zinc-500 text-sm text-center">No data</div>';
      return;
    }

    const total = providers.reduce((s: number, [, v]: [string, number]) => s + v, 0);
    const cx = 90,
      cy = 90,
      r = 70,
      strokeW = 18;
    const circumference = 2 * Math.PI * r;

    let offset = 0;
    const segments = providers.map(([p, count]: [string, number]) => {
      const pct = count / total;
      const dashLen = pct * circumference;
      const seg = { provider: p, count, pct, offset, dashLen };
      offset += dashLen;
      return seg;
    });

    container.innerHTML = `
      <svg viewBox="0 0 180 180" style="transform:rotate(-90deg)">
        ${segments
          .map((s) => {
            const color = PROVIDER_COLORS[s.provider] || '#71717a';
            return `<circle class="mm-ring-segment" cx="${cx}" cy="${cy}" r="${r}" fill="none"
            stroke="${color}" stroke-width="${strokeW}"
            stroke-dasharray="${s.dashLen} ${circumference - s.dashLen}"
            stroke-dashoffset="${-s.offset}"
            data-provider="${escapeHtml(s.provider)}" />`;
          })
          .join('')}
      </svg>
      <div class="absolute inset-0 flex flex-col items-center justify-center" style="pointer-events:none">
        <span class="text-2xl font-bold text-white">${total}</span>
        <span class="text-[10px] text-zinc-500">models</span>
      </div>
    `;

    legend.innerHTML = providers
      .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
      .map(([p, count]) => {
        const color = PROVIDER_COLORS[p] || '#71717a';
        const label = PROVIDER_LABELS[p] || p;
        return `<div class="flex items-center gap-1.5 text-[11px]">
        <span class="w-2 h-2 rounded-full" style="background:${color}"></span>
        <span class="text-zinc-400">${escapeHtml(label)}</span>
        <span class="text-zinc-600 font-mono">${count}</span>
      </div>`;
      })
      .join('');
  }
}
