import { escapeHtml } from '../../../utils/sanitize.js';
import { ModelToast } from '../model-toast.js';
import { icons } from '../icons.js';
const PROVIDER_OPTIONS = [
    { value: 'openrouter', label: 'OpenRouter', hint: 'Requires OPENROUTER_API_KEY' },
    { value: 'groq', label: 'Groq', hint: 'Requires GROQ_API_KEY' },
    { value: 'mistral', label: 'Mistral AI', hint: 'Requires MISTRAL_API_KEY' },
    { value: 'nvidia_nim', label: 'Nvidia NIM', hint: 'Requires NVIDIA_API_KEY' },
    { value: 'cerebras', label: 'Cerebras', hint: 'Requires CEREBRAS_API_KEY' },
    { value: 'kilo', label: 'Kilo Gateway', hint: 'Requires KILO_API_KEY' },
    { value: '', label: 'Other / Auto-detect', hint: 'Provider inferred from model ID' },
];
const TIER_OPTIONS = [
    { value: '', label: 'None', desc: "Don't auto-add to tier" },
    { value: 'tier-4-planner', label: 'Tier 4: Planner', desc: 'Highest complexity tasks' },
    { value: 'tier-3-builder', label: 'Tier 3: Builder', desc: 'Complex coding & reasoning' },
    { value: 'tier-2-hunter', label: 'Tier 2: Hunter', desc: 'Standard tasks' },
    { value: 'tier-1-trivial', label: 'Tier 1: Trivial', desc: 'Simple / fast tasks' },
];
export class AddModelView {
    constructor(api, state, cache) {
        this.api = api;
        this.state = state;
        this.cache = cache;
        this.isSubmitting = false;
    }
    async mount(container) {
        this.container = document.createElement('div');
        this.container.className = 'h-full flex flex-col gap-4';
        container.appendChild(this.container);
        this._render();
        this._attachListeners();
        this._updatePreview();
    }
    unmount() { }
    _render() {
        this.container.innerHTML = `
      <div class="shrink-0">
        <h1 class="text-xl font-bold text-white tracking-tight">Add a Model</h1>
        <p class="text-sm text-zinc-400 mt-1">Configure and add a new model to LiteLLM</p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-grow min-h-0 overflow-y-auto custom-scrollbar">
        <div class="lg:col-span-2 space-y-4">
          <div class="glass-panel p-5 space-y-5">
            <div class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Configuration</div>

            <div>
              <label class="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">Model Name (Alias)</label>
              <input type="text" id="add-model-name" placeholder="e.g. openai/tier-4-planner-fb12" class="w-full px-4 py-2.5 bg-zinc-900/50 border border-white/5 focus:border-primary/50 focus:outline-none rounded-xl text-sm text-zinc-200 transition">
              <p class="text-[10px] text-zinc-500 mt-1">Unique alias for routing — must be unique across all models.</p>
            </div>

            <div>
              <label class="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">Upstream Provider</label>
              <select id="add-model-provider" class="w-full px-4 py-2.5 bg-zinc-900 border border-white/5 focus:border-primary/50 focus:outline-none rounded-xl text-sm text-zinc-200 transition">
                ${PROVIDER_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
              </select>
              <p id="provider-hint" class="text-[10px] text-zinc-500 mt-1">${PROVIDER_OPTIONS[0].hint}</p>
            </div>

            <div>
              <label class="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">Upstream Model ID</label>
              <input type="text" id="add-model-id" placeholder="e.g. deepseek/deepseek-r1:free" class="w-full px-4 py-2.5 bg-zinc-900/50 border border-white/5 focus:border-primary/50 focus:outline-none rounded-xl text-sm text-zinc-200 transition">
              <p class="text-[10px] text-zinc-500 mt-1">The actual model identifier at the upstream provider.</p>
            </div>
          </div>

          <div class="glass-panel p-5 space-y-5">
            <div class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Options</div>

            <div>
              <label class="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">Auto-add to Tier Fallback</label>
              <select id="add-model-tier" class="w-full px-4 py-2.5 bg-zinc-900 border border-white/5 focus:border-primary/50 focus:outline-none rounded-xl text-sm text-zinc-200 transition">
                ${TIER_OPTIONS.map((o) => `<option value="${o.value}">${o.label}${o.desc ? ' — ' + o.desc : ''}</option>`).join('')}
              </select>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">RPM Limit</label>
                <input type="number" id="add-model-rpm" value="" placeholder="e.g. 10" class="w-full px-4 py-2.5 bg-zinc-900/50 border border-white/5 focus:border-primary/50 focus:outline-none rounded-xl text-sm text-zinc-200 transition">
              </div>
              <div>
                <label class="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">API Key Override</label>
                <input type="password" id="add-model-key" placeholder="Uses env var if blank" class="w-full px-4 py-2.5 bg-zinc-900/50 border border-white/5 focus:border-primary/50 focus:outline-none rounded-xl text-sm text-zinc-200 transition">
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-4">
          <div class="glass-panel p-5 space-y-4 sticky top-0">
            <div class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Live Preview</div>
            <div id="add-preview" class="bg-zinc-900/50 border border-white/5 rounded-xl p-4 font-mono text-[11px] text-zinc-300 space-y-1 overflow-x-auto custom-scrollbar max-h-64 overflow-y-auto">
              <span class="text-zinc-500">Fill in the form...</span>
            </div>

            <div class="flex items-center gap-2 text-[10px]" id="add-validation">
              <span class="mm-status-dot unchecked"></span>
              <span class="text-zinc-500">Required fields empty</span>
            </div>

            <div class="flex gap-3 pt-3 border-t border-white/5">
              <button id="add-cancel" class="px-4 py-2.5 rounded-xl bg-white/[0.02] border border-white/5 text-sm text-zinc-400 hover:bg-white/[0.05] hover:text-white transition font-semibold flex-1">Cancel</button>
              <button id="add-save" class="px-5 py-2.5 bg-primary hover:bg-primary/95 text-white font-semibold rounded-xl text-sm transition flex items-center justify-center gap-2 flex-1">
                <span style="width:16px;height:16px">${icons.check}</span>
                <span>Save</span>
              </button>
            </div>
          </div>

          <div class="glass-panel p-5 space-y-3">
            <div class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Quick Tips</div>
            <div class="space-y-2 text-[11px] text-zinc-500">
              <div class="flex items-start gap-2"><span class="text-primary mt-0.5">1.</span>Name must be unique — use provider prefix for clarity</div>
              <div class="flex items-start gap-2"><span class="text-primary mt-0.5">2.</span>Model ID is the upstream identifier, not the alias</div>
              <div class="flex items-start gap-2"><span class="text-primary mt-0.5">3.</span>Setting a tier auto-appends to that fallback chain</div>
              <div class="flex items-start gap-2"><span class="text-primary mt-0.5">4.</span>Leave API Key blank to use environment variable</div>
            </div>
          </div>
        </div>
      </div>
    `;
        this.inputs = {
            name: this.container.querySelector('#add-model-name'),
            provider: this.container.querySelector('#add-model-provider'),
            modelId: this.container.querySelector('#add-model-id'),
            tier: this.container.querySelector('#add-model-tier'),
            rpm: this.container.querySelector('#add-model-rpm'),
            key: this.container.querySelector('#add-model-key'),
        };
        this.saveBtn = this.container.querySelector('#add-save');
        this.previewEl = this.container.querySelector('#add-preview');
        this.validationEl = this.container.querySelector('#add-validation');
        this.providerHint = this.container.querySelector('#provider-hint');
    }
    _attachListeners() {
        this.container.querySelector('#add-cancel').addEventListener('click', () => {
            this.state.update({ activeView: 'all' });
        });
        Object.values(this.inputs).forEach((input) => {
            input.addEventListener('input', () => this._updatePreview());
            input.addEventListener('change', () => this._updatePreview());
        });
        this.inputs.provider.addEventListener('change', () => {
            const opt = PROVIDER_OPTIONS.find((o) => o.value === this.inputs.provider.value);
            this.providerHint.textContent = opt ? opt.hint : '';
        });
        this.saveBtn.addEventListener('click', () => this._handleSave());
    }
    _updatePreview() {
        const name = this.inputs.name.value.trim();
        const provider = this.inputs.provider.value;
        const modelId = this.inputs.modelId.value.trim();
        const tier = this.inputs.tier.value;
        const rpm = this.inputs.rpm.value;
        const hasKey = this.inputs.key.value.trim().length > 0;
        const valid = name && modelId;
        const statusHtml = valid
            ? '<span class="mm-status-dot healthy"></span><span class="text-emerald-400">Ready to save</span>'
            : '<span class="mm-status-dot unchecked"></span><span class="text-zinc-500">Required fields empty</span>';
        this.validationEl.innerHTML = statusHtml;
        this.previewEl.innerHTML = `<div><span class="text-zinc-500">model_name:</span> <span class="${name ? 'text-emerald-400' : 'text-rose-400'}">"${escapeHtml(name || '...')}"</span></div>
<div><span class="text-zinc-500">litellm_params.model:</span> <span class="${modelId ? 'text-emerald-400' : 'text-rose-400'}">"${escapeHtml(modelId || '...')}"</span></div>
${provider ? `<div><span class="text-zinc-500">provider:</span> <span class="text-blue-400">"${escapeHtml(provider)}"</span></div>` : ''}
${tier ? `<div><span class="text-zinc-500">tier:</span> <span class="text-purple-400">"${escapeHtml(tier)}"</span></div>` : ''}
${rpm ? `<div><span class="text-zinc-500">rpm_limit:</span> <span class="text-amber-400">${escapeHtml(rpm)}</span></div>` : ''}
<div><span class="text-zinc-500">api_key:</span> <span class="text-zinc-400">${hasKey ? '"••••••••"' : '(env variable)'}</span></div>`;
    }
    async _handleSave() {
        if (this.isSubmitting)
            return;
        const payload = {
            model_name: this.inputs.name.value.trim(),
            provider: this.inputs.provider.value,
            model_id: this.inputs.modelId.value.trim(),
            tier: this.inputs.tier.value,
            rpm: this.inputs.rpm.value ? parseInt(this.inputs.rpm.value, 10) : null,
            api_key: this.inputs.key.value.trim() || null,
        };
        if (!payload.model_name || !payload.model_id) {
            ModelToast.show('Model Name and Upstream Model ID are required', 'error');
            return;
        }
        this.isSubmitting = true;
        this.saveBtn.disabled = true;
        this.saveBtn.innerHTML = `<span class="mm-spin" style="width:16px;height:16px">${icons.spinner}</span> <span>Saving...</span>`;
        try {
            const res = await this.api.post('/model-config/add', payload);
            if (res && res.success) {
                ModelToast.show(`Model ${payload.model_name} added successfully!`, 'success');
                this.cache.invalidateAll();
                setTimeout(() => this.state.update({ activeView: 'all' }), 1000);
            }
            else {
                throw new Error(res.error || 'Failed to add model');
            }
        }
        catch (err) {
            ModelToast.show(`Error: ${err.message}`, 'error');
            this.isSubmitting = false;
            this.saveBtn.disabled = false;
            this.saveBtn.innerHTML = `<span style="width:16px;height:16px">${icons.check}</span> <span>Save</span>`;
        }
    }
}
