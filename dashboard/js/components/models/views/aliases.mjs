import { escapeHtml } from '../../../utils/sanitize.mjs';
import { ModelToast } from '../model-toast.mjs';
import { icons } from '../icons.mjs';

export class AliasesView {
  constructor(api, state, cache) {
    this.api = api;
    this.state = state;
    this.cache = cache;
    this.tiers = [];
    this.allModels = [];
    this.healthData = [];
    this.isSubmitting = false;
    this._dragTier = null;
    this._dragIdx = null;
    this._dragIsPrimary = false;
  }

  async mount(container) {
    this.container = document.createElement('div');
    this.container.className = 'h-full flex flex-col gap-4';
    container.appendChild(this.container);

    this._renderStatic();
    await this.loadAliases();
  }

  unmount() {}

  _renderStatic() {
    this.container.innerHTML = `
      <div class="flex items-center justify-between shrink-0">
        <div>
          <h1 class="text-xl font-bold text-white tracking-tight">Fallback Chains</h1>
          <p class="text-sm text-zinc-400 mt-1">Drag to reorder — primary and fallbacks can all be rearranged</p>
        </div>
      </div>
      <div id="alias-list" class="flex-grow min-h-0 overflow-y-auto custom-scrollbar grid grid-cols-1 xl:grid-cols-2 gap-4 content-start">
        <div class="flex items-center justify-center py-16">
          <span class="mm-spin" style="width:24px;height:24px;display:block;color:#71717a">${icons.spinner}</span>
          <span class="ml-3 text-zinc-500 text-sm">Loading tier groups...</span>
        </div>
      </div>
    `;
    this.listEl = this.container.querySelector('#alias-list');

    this.listEl.addEventListener('click', (e) => {
      const rmBtn = e.target.closest('.rm-fallback');
      if (rmBtn) this.removeFallback(rmBtn.dataset.tier, parseInt(rmBtn.dataset.index, 10));

      const rmPrimaryBtn = e.target.closest('.rm-primary');
      if (rmPrimaryBtn) this.removePrimary(rmPrimaryBtn.dataset.tier);
    });

    this.listEl.addEventListener('change', (e) => {
      const select = e.target.closest('.add-fallback-select');
      if (select && select.value) {
        this.addFallback(select.dataset.tier, select.value);
        select.value = '';
      }
    });
  }

  async loadAliases() {
    try {
      const [tiers, models, health] = await Promise.all([
        this.api.get('/model-aliases'),
        this.api.get('/model-config').catch(() => []),
        this.api.get('/model-health').catch(() => []),
      ]);
      this.tiers = tiers;
      this.allModels = models;
      this.healthData = health || [];
      this.renderList();
    } catch (err) {
      this.listEl.innerHTML = `<div class="mm-empty-state"><div class="es-icon">${icons.tags}</div><p class="text-sm text-rose-400">Failed to load: ${escapeHtml(err.message)}</p></div>`;
    }
  }

  renderList() {
    if (!Array.isArray(this.tiers) || !this.tiers.length) {
      this.listEl.innerHTML =
        '<div class="mm-empty-state"><div class="es-icon">${icons.tags}</div><p class="text-sm text-zinc-500">No tier groups configured.</p></div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    // Group models by resolved provider for select dropdown
    const groups = {};
    this.allModels.forEach((m) => {
      const provider = m.model_info?.provider || this._resolveProvider(m.litellm_params?.model || m.model_name);
      const providerLabel = provider && provider !== 'unknown'
        ? (provider.charAt(0).toUpperCase() + provider.slice(1))
        : 'Other';
      if (!groups[providerLabel]) groups[providerLabel] = [];
      groups[providerLabel].push(m);
    });

    const optGroupsHtml = Object.keys(groups).sort().map((groupLabel) => {
      const models = groups[groupLabel];
      return `
        <optgroup label="${escapeHtml(groupLabel)}" style="background:#18181b;color:#a1a1aa">
          ${models.map((m) => `<option value="${escapeHtml(m.model_name)}" style="background:#18181b;color:#f4f4f5">${escapeHtml(m.model_name)} (${escapeHtml(m.litellm_params?.model || '')})</option>`).join('')}
        </optgroup>
      `;
    }).join('');

    this.tiers.forEach((t) => {
      const fbCount = t.fallbacks.length;
      const primaryHealth = t.primary ? this._getModelHealth(t.primary) : 'unchecked';
      const div = document.createElement('div');
      div.className = 'glass-panel p-0 overflow-hidden';

      const fbItems =
        t.fallbacks.length === 0
          ? '<div class="text-xs text-zinc-600 text-center py-3 italic">No fallbacks configured</div>'
          : t.fallbacks
              .map((fb, i) => {
                const isLast = i === t.fallbacks.length - 1;
                const fallbackHealth = this._getModelHealth(fb);
                const displayName = this._resolveModelDisplayName(fb.model);
                return `
          <div class="mm-fallback-item" draggable="true" data-tier="${escapeHtml(t.tier)}" data-index="${i}">
            <span class="mm-drag-handle" style="width:16px;height:16px">${icons.grip}</span>
            <div class="flex items-center gap-2 flex-grow min-w-0">
              <span class="text-[10px] font-mono text-zinc-500 w-6">#${i + 1}</span>
              <div class="flex flex-col min-w-0">
                <span class="text-sm text-zinc-200 font-semibold truncate">${escapeHtml(displayName)}</span>
                <span class="text-[10px] text-zinc-500 font-mono truncate">${escapeHtml(fb.model)}</span>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${this._getHealthBadge(fallbackHealth)}
              <button class="rm-fallback p-1.5 text-rose-400 hover:text-rose-300 bg-rose-500/10 rounded-lg transition" data-tier="${escapeHtml(t.tier)}" data-index="${i}" title="Remove">
                <span style="width:12px;height:12px;display:block">${icons.x}</span>
              </button>
            </div>
          </div>
          ${!isLast ? '<div class="flex justify-center"><div class="w-px h-3 bg-white/10"></div></div>' : ''}
        `;
              })
              .join('');

      let primaryHtml = '';
      if (t.primary) {
        const displayName = this._resolveModelDisplayName(t.primary.model);
        primaryHtml = `
          <div class="primary-item flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-emerald-500/5 border border-emerald-500/15" draggable="true" data-tier="${escapeHtml(t.tier)}" data-primary="true">
            <div class="flex items-center gap-3 min-w-0">
              <span class="mm-drag-handle shrink-0" style="width:16px;height:16px">${icons.grip}</span>
              <span class="text-[10px] text-emerald-500 font-bold px-2 py-0.5 border border-emerald-500/20 rounded-md bg-emerald-500/10 shrink-0">PRIMARY</span>
              <div class="flex flex-col min-w-0">
                <span class="text-sm text-emerald-400 font-bold truncate">${escapeHtml(displayName)}</span>
                <span class="text-[10px] text-emerald-600/70 font-mono truncate">${escapeHtml(t.primary.model)}</span>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${this._getHealthBadge(primaryHealth)}
              <button class="rm-primary p-1.5 text-rose-400 hover:text-rose-300 bg-rose-500/10 rounded-lg transition" data-tier="${escapeHtml(t.tier)}" title="Remove Primary">
                <span style="width:12px;height:12px;display:block">${icons.x}</span>
              </button>
            </div>
          </div>
        `;
      } else {
        primaryHtml = `
          <div class="primary-item flex items-center gap-3 px-3 py-2.5 rounded-xl bg-zinc-900/10 border border-white/5 border-dashed" data-tier="${escapeHtml(t.tier)}" data-primary="true">
            <span class="text-[10px] text-zinc-500 font-bold px-2 py-0.5 border border-white/10 rounded-md bg-white/[0.02] shrink-0">PRIMARY</span>
            <span class="text-sm text-zinc-500 italic">No primary model set — drag a fallback here</span>
          </div>
        `;
      }

      div.innerHTML = `
        <div class="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-white/[0.02]">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-semibold text-white">${escapeHtml(t.tier)}</span>
              <span class="text-[10px] text-zinc-500 font-mono bg-white/[0.03] px-1.5 py-0.5 rounded">openai/${escapeHtml(t.tier)}</span>
            </div>
            <div class="text-xs text-zinc-500 mt-0.5">${escapeHtml(t.label)}</div>
          </div>
          <span class="text-xs text-zinc-500">${fbCount} fallback${fbCount === 1 ? '' : 's'}</span>
        </div>
        <div class="px-4 py-3 space-y-2">
          ${primaryHtml}
          <div class="pl-2 mt-2 space-y-2 border-l-2 border-white/5">
            ${fbItems}
          </div>
          <div class="mt-3 pt-3 border-t border-white/5">
            <select class="add-fallback-select text-xs bg-zinc-900/50 border border-white/5 rounded-xl px-3 py-2 text-zinc-300 focus:outline-none focus:border-primary/50 w-full" data-tier="${escapeHtml(t.tier)}">
              <option value="">+ Add Fallback Model...</option>
              ${optGroupsHtml}
            </select>
          </div>
        </div>
      `;

      fragment.appendChild(div);
    });

    this.listEl.replaceChildren(fragment);
    this._setupDragDrop();
  }

  _setupDragDrop() {
    const items = this.listEl.querySelectorAll('.mm-fallback-item, .primary-item');
    for (const item of items) {
      item.addEventListener('dragstart', (e) => {
        this._dragTier = item.dataset.tier;
        this._dragIsPrimary = item.dataset.primary === 'true';
        this._dragIdx = this._dragIsPrimary ? -1 : parseInt(item.dataset.index, 10);
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        this.listEl
          .querySelectorAll('.mm-fallback-item, .primary-item')
          .forEach((el) => el.classList.remove('drag-over'));
        this._dragTier = null;
        this._dragIdx = null;
        this._dragIsPrimary = false;
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (item.dataset.tier === this._dragTier) {
          item.classList.add('drag-over');
        }
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const targetTier = item.dataset.tier;
        const targetIsPrimary = item.dataset.primary === 'true';
        const targetIdx = targetIsPrimary ? -1 : parseInt(item.dataset.index, 10);

        if (targetTier !== this._dragTier) return;

        if (this._dragIsPrimary && targetIsPrimary) return;

        if (this._dragIsPrimary) {
          this.promoteFallback(targetTier, targetIdx);
        } else if (targetIsPrimary) {
          this.promoteFallback(targetTier, this._dragIdx);
        } else {
          if (this._dragIdx !== null && this._dragIdx !== targetIdx) {
            this.moveFallback(targetTier, this._dragIdx, targetIdx);
          }
        }
      });
    }
  }

  promoteFallback(tierName, fbIndex) {
    const tier = this.tiers.find((t) => t.tier === tierName);
    if (!tier || fbIndex < 0 || fbIndex >= tier.fallbacks.length) return;

    const promoted = tier.fallbacks[fbIndex];
    if (!promoted) return;

    if (tier.primary) {
      const oldPrimaryModel = tier.primary.model;
      tier.primary.model = promoted.model;
      promoted.model = oldPrimaryModel;
      this.renderList();
      this.saveSwap(tierName, fbIndex);
    } else {
      tier.primary = {
        alias: `openai/${tierName}`,
        model: promoted.model,
        rpm: promoted.rpm || null,
        timeout: promoted.timeout || null,
        context: promoted.context || null,
      };
      tier.fallbacks.splice(fbIndex, 1);
      this.renderList();
      this.saveSwap(tierName, -1);
    }
  }

  async removeFallback(tierName, index) {
    const tier = this.tiers.find((t) => t.tier === tierName);
    if (!tier) return;
    tier.fallbacks.splice(index, 1);
    this.renderList();
    await this.saveTier(tierName);
  }

  async removePrimary(tierName) {
    const tier = this.tiers.find((t) => t.tier === tierName);
    if (!tier) return;
    tier.primary = null;
    this.renderList();
    await this.saveTier(tierName);
  }

  async addFallback(tierName, aliasName) {
    const tier = this.tiers.find((t) => t.tier === tierName);
    if (!tier) return;
    const model = this.allModels.find((m) => m.model_name === aliasName);
    const actualId = model ? model.litellm_params?.model || aliasName : aliasName;

    if (tier.primary && tier.primary.model === actualId) {
      ModelToast.show('Model is already the primary model for this tier', 'error');
      return;
    }
    if (tier.fallbacks.some((f) => f.model === actualId)) {
      ModelToast.show('Model already in fallback chain', 'error');
      return;
    }

    if (this.isSubmitting) return;
    this.isSubmitting = true;
    try {
      const res = await this.api.post('/model-aliases/add', {
        tier: tierName,
        model: actualId
      });
      if (res && res.success) {
        ModelToast.show(`Added fallback ${aliasName} to ${tierName}`, 'success');
        this.cache.invalidateAll();
        await this.loadAliases();
      } else {
        throw new Error(res.error || 'Failed to add fallback');
      }
    } catch (err) {
      ModelToast.show(`Error adding fallback: ${err.message}`, 'error');
    } finally {
      this.isSubmitting = false;
    }
  }

  async moveFallback(tierName, fromIdx, toIdx) {
    const tier = this.tiers.find((t) => t.tier === tierName);
    if (!tier) return;
    const [moved] = tier.fallbacks.splice(fromIdx, 1);
    tier.fallbacks.splice(toIdx, 0, moved);
    this.renderList();
    await this.saveTier(tierName);
  }

  async saveSwap(tierName, fbIndex) {
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    const tier = this.tiers.find((t) => t.tier === tierName);
    if (!tier) return;
    try {
      const payload = {
        tier: tier.tier,
        fallbacks: tier.fallbacks.map((f) => f.alias),
        swapPrimaryWith: fbIndex,
        primaryModel: tier.primary ? tier.primary.model : null,
      };
      const res = await this.api.post('/model-aliases', payload);
      if (res && res.success) {
        ModelToast.show(
          `Swapped primary with ${tier.fallbacks[fbIndex]?.alias || 'fallback'}`,
          'success',
        );
        this.cache.invalidateAll();
        await this.loadAliases();
      } else {
        throw new Error(res.error || 'Failed to save');
      }
    } catch (err) {
      ModelToast.show(`Error: ${err.message}`, 'error');
    } finally {
      this.isSubmitting = false;
    }
  }

  async saveTier(tierName) {
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    const tier = this.tiers.find((t) => t.tier === tierName);
    if (!tier) return;
    try {
      const payload = {
        tier: tier.tier,
        fallbacks: tier.fallbacks.map((f) => f.alias),
        primaryModel: tier.primary ? tier.primary.model : null,
      };
      const res = await this.api.post('/model-aliases', payload);
      if (res && res.success) {
        ModelToast.show(`Saved fallbacks for ${tier.tier}`, 'success');
        this.cache.invalidateAll();
        await this.loadAliases();
      } else {
        throw new Error(res.error || 'Failed to save');
      }
    } catch (err) {
      ModelToast.show(`Error saving fallbacks: ${err.message}`, 'error');
    } finally {
      this.isSubmitting = false;
    }
  }

  _getModelHealth(model) {
    if (!this.healthData || !model) return 'unchecked';

    // 1. Try matching by alias first (e.g. "openai/tier-4-planner-fb1")
    if (model.alias) {
      const byAlias = this.healthData.find((h) =>
        h.aliases && h.aliases.includes(model.alias)
      );
      if (byAlias) return byAlias.health_status;
    }

    // 2. Try matching by underlying model string (e.g. "groq/llama-3.3-70b-versatile")
    const searchModel = model.model || model.model_name || '';
    const cleanSearchModel = searchModel.startsWith('openai/')
      ? searchModel.replace('openai/', '')
      : searchModel;

    const byModel = this.healthData.find((h) => {
      const hModelClean = h.actual_model.startsWith('openai/')
        ? h.actual_model.replace('openai/', '')
        : h.actual_model;

      return h.actual_model === searchModel ||
             hModelClean === cleanSearchModel ||
             (h.aliases && h.aliases.includes(searchModel));
    });

    return byModel ? byModel.health_status : 'unchecked';
  }

  _resolveProvider(modelStr) {
    if (!modelStr) return 'unknown';
    const lower = modelStr.toLowerCase();
    if (lower.startsWith('opencode/')) return 'opencode';
    if (lower.startsWith('openrouter/')) return 'openrouter';
    if (lower.startsWith('groq/')) return 'groq';
    if (lower.startsWith('mistral/') || lower.startsWith('codestral/') || lower.startsWith('ministral/')) return 'mistral';
    if (lower.startsWith('nvidia/') || lower.startsWith('nvidia_nim/')) return 'nvidia';
    if (lower.startsWith('kilo/') || lower.startsWith('kilocode/')) return 'kilo';
    if (lower.startsWith('cerebras/')) return 'cerebras';
    if (lower.startsWith('ollama/')) return 'ollama';

    if (lower.includes('big-pickle') || lower.includes('north-mini-code-free') || lower.includes('mimo-v2.5')) return 'opencode';
    if (lower.includes('nemotron-3-ultra')) return 'opencode';
    if (lower.includes('openrouter')) return 'openrouter';
    if (lower.includes('groq')) return 'groq';
    if (lower.includes('mistral') || lower.includes('codestral') || lower.includes('ministral')) return 'mistral';
    if (lower.includes('nvidia') || lower.includes('nim')) return 'nvidia';
    if (lower.includes('opencode') || lower.includes('zen')) return 'opencode';
    if (lower.includes('kilo')) return 'kilo';
    if (lower.includes('cerebras')) return 'cerebras';
    if (lower.includes('ollama')) return 'ollama';
    return 'unknown';
  }

  _resolveModelDisplayName(modelStr) {
    if (!modelStr) return '';

    const targetProvider = this._resolveProvider(modelStr);

    const clean = (str) => {
      if (!str) return '';
      let s = str.toLowerCase();
      const slashIdx = s.indexOf('/');
      if (slashIdx !== -1) {
        const prefix = s.substring(0, slashIdx);
        if (['openai', 'openrouter', 'opencode', 'groq', 'mistral', 'nvidia', 'kilo', 'cerebras', 'ollama'].includes(prefix)) {
          s = s.substring(slashIdx + 1);
        }
      }
      const secondSlash = s.indexOf('/');
      if (secondSlash !== -1) {
        const prefix = s.substring(0, secondSlash);
        if (['openrouter', 'opencode', 'groq', 'mistral', 'nvidia', 'kilo', 'cerebras', 'ollama'].includes(prefix)) {
          s = s.substring(secondSlash + 1);
        }
      }
      return s.trim();
    };

    const targetClean = clean(modelStr);

    // 1. Exact match by litellm_params.model and matching provider
    let bestMatch = this.allModels.find((m) => {
      const mProvider = m.model_info?.provider || this._resolveProvider(m.litellm_params?.model || m.model_name);
      return m.litellm_params?.model === modelStr && mProvider === targetProvider;
    });

    // 2. Loose match by cleaned model_name and matching provider
    if (!bestMatch) {
      bestMatch = this.allModels.find((m) => {
        const mProvider = m.model_info?.provider || this._resolveProvider(m.litellm_params?.model || m.model_name);
        return clean(m.model_name) === targetClean && mProvider === targetProvider;
      });
    }

    // 3. Loose match by cleaned litellm_params.model and matching provider
    if (!bestMatch) {
      bestMatch = this.allModels.find((m) => {
        const mProvider = m.model_info?.provider || this._resolveProvider(m.litellm_params?.model || m.model_name);
        return clean(m.litellm_params?.model) === targetClean && mProvider === targetProvider;
      });
    }

    // 4. Exact string fallback (checking that provider is not conflicting)
    if (!bestMatch) {
      bestMatch = this.allModels.find((m) => {
        const mProvider = m.model_info?.provider || this._resolveProvider(m.litellm_params?.model || m.model_name);
        return m.litellm_params?.model === modelStr && (mProvider === targetProvider || targetProvider === 'unknown' || mProvider === 'unknown');
      });
    }

    if (bestMatch) {
      return bestMatch.model_name;
    }

    if (modelStr.startsWith('openai/')) {
      return modelStr.substring(7);
    }
    return modelStr;
  }

  _getHealthBadge(status) {
    let dotClass = 'bg-zinc-500';
    let textClass = 'text-zinc-500 border-zinc-500/20 bg-zinc-500/5';
    let label = 'Unchecked';

    if (status === 'healthy') {
      dotClass = 'bg-emerald-500';
      textClass = 'text-emerald-500 border-emerald-500/20 bg-emerald-500/5';
      label = 'Healthy';
    } else if (status === 'unhealthy') {
      dotClass = 'bg-rose-500';
      textClass = 'text-rose-500 border-rose-500/20 bg-rose-500/5';
      label = 'Unhealthy';
    } else if (status === 'deprecated') {
      dotClass = 'bg-amber-500';
      textClass = 'text-amber-500 border-amber-500/20 bg-amber-500/5';
      label = 'Deprecated';
    }

    return `
      <div class="flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-bold border rounded-md uppercase ${textClass}">
        <span class="w-1.5 h-1.5 rounded-full ${dotClass}"></span>
        <span>${label}</span>
      </div>
    `;
  }
}
