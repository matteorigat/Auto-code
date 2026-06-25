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
      const [tiers, models] = await Promise.all([
        this.api.get('/model-aliases'),
        this.api.get('/model-config').catch(() => []),
      ]);
      this.tiers = tiers;
      this.allModels = models;
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

    this.tiers.forEach((t) => {
      const fbCount = t.fallbacks.length;
      const primaryModel = t.primary
        ? t.primary.model
        : '<span class="text-zinc-600 italic">-</span>';
      const div = document.createElement('div');
      div.className = 'glass-panel p-0 overflow-hidden';

      const fbItems =
        t.fallbacks.length === 0
          ? '<div class="text-xs text-zinc-600 text-center py-3 italic">No fallbacks configured</div>'
          : t.fallbacks
              .map((fb, i) => {
                const isLast = i === t.fallbacks.length - 1;
                return `
          <div class="mm-fallback-item" draggable="true" data-tier="${escapeHtml(t.tier)}" data-index="${i}">
            <span class="mm-drag-handle" style="width:16px;height:16px">${icons.grip}</span>
            <div class="flex items-center gap-2 flex-grow min-w-0">
              <span class="text-[10px] font-mono text-zinc-500 w-6">#${i + 1}</span>
              <div class="flex flex-col min-w-0">
                <span class="text-sm text-zinc-200 font-semibold truncate">${escapeHtml(fb.alias)}</span>
                <span class="text-[10px] text-zinc-500 font-mono truncate">${escapeHtml(fb.model)}</span>
              </div>
            </div>
            <button class="rm-fallback p-1.5 text-rose-400 hover:text-rose-300 bg-rose-500/10 rounded-lg transition" data-tier="${escapeHtml(t.tier)}" data-index="${i}" title="Remove">
              <span style="width:12px;height:12px;display:block">${icons.x}</span>
            </button>
          </div>
          ${!isLast ? '<div class="flex justify-center"><div class="w-px h-3 bg-white/10"></div></div>' : ''}
        `;
              })
              .join('');

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
          <div class="primary-item flex items-center gap-3 px-3 py-2.5 rounded-xl bg-emerald-500/5 border border-emerald-500/15" draggable="true" data-tier="${escapeHtml(t.tier)}" data-primary="true">
            <span class="mm-drag-handle" style="width:16px;height:16px">${icons.grip}</span>
            <span class="text-[10px] text-emerald-500 font-bold px-2 py-0.5 border border-emerald-500/20 rounded-md bg-emerald-500/10">PRIMARY</span>
            <span class="text-sm text-emerald-400 font-bold">${primaryModel}</span>
          </div>
          <div class="pl-2 mt-2 space-y-2 border-l-2 border-white/5">
            ${fbItems}
          </div>
          <div class="mt-3 pt-3 border-t border-white/5">
            <select class="add-fallback-select text-xs bg-zinc-900/50 border border-white/5 rounded-xl px-3 py-2 text-zinc-300 focus:outline-none focus:border-primary/50 w-full" data-tier="${escapeHtml(t.tier)}">
              <option value="">+ Add Fallback Model...</option>
              ${this.allModels.map((m) => `<option value="${escapeHtml(m.model_name)}">${escapeHtml(m.model_name)} (${escapeHtml(m.litellm_params?.model || '')})</option>`).join('')}
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
    if (!tier || !tier.primary || fbIndex < 0 || fbIndex >= tier.fallbacks.length) return;

    const promoted = tier.fallbacks[fbIndex];
    if (!promoted) return;

    const oldPrimaryModel = tier.primary.model;
    tier.primary.model = promoted.model;
    promoted.model = oldPrimaryModel;

    this.renderList();
    this.saveSwap(tierName, fbIndex);
  }

  async removeFallback(tierName, index) {
    const tier = this.tiers.find((t) => t.tier === tierName);
    if (!tier) return;
    tier.fallbacks.splice(index, 1);
    this.renderList();
    await this.saveTier(tierName);
  }

  async addFallback(tierName, aliasName) {
    const tier = this.tiers.find((t) => t.tier === tierName);
    if (!tier) return;
    if (tier.fallbacks.some((f) => f.alias === aliasName)) {
      ModelToast.show('Model already in fallback chain', 'error');
      return;
    }
    const model = this.allModels.find((m) => m.model_name === aliasName);
    const actualId = model ? model.litellm_params?.model || aliasName : aliasName;
    tier.fallbacks.push({ alias: aliasName, model: actualId });
    this.renderList();
    await this.saveTier(tierName);
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
      const payload = { tier: tier.tier, fallbacks: tier.fallbacks.map((f) => f.alias) };
      const res = await this.api.post('/model-aliases', payload);
      if (res && res.success) {
        ModelToast.show(`Saved fallbacks for ${tier.tier}`, 'success');
        this.cache.invalidateAll();
      } else {
        throw new Error(res.error || 'Failed to save');
      }
    } catch (err) {
      ModelToast.show(`Error saving fallbacks: ${err.message}`, 'error');
    } finally {
      this.isSubmitting = false;
    }
  }
}
