import { ModelToast } from '../model-toast.js';
import { icons } from '../icons.js';
const PRESETS = {
    conservative: {
        label: 'Conservative',
        desc: 'More retries, longer cooldowns',
        num_retries: 4,
        allowed_fails: 5,
        cooldown_time: 300,
        rate_limit_fails_allowed: 8,
    },
    balanced: {
        label: 'Balanced',
        desc: 'Good defaults for most workloads',
        num_retries: 2,
        allowed_fails: 3,
        cooldown_time: 120,
        rate_limit_fails_allowed: 5,
    },
    aggressive: {
        label: 'Aggressive',
        desc: 'Fewer retries, quick cooldowns',
        num_retries: 1,
        allowed_fails: 1,
        cooldown_time: 30,
        rate_limit_fails_allowed: 2,
    },
    custom: {
        label: 'Custom',
        desc: 'Your own configuration',
        num_retries: null,
        allowed_fails: null,
        cooldown_time: null,
        rate_limit_fails_allowed: null,
    },
};
export class RetrySettingsView {
    constructor(api, state, cache) {
        this.api = api;
        this.state = state;
        this.cache = cache;
        this.isSubmitting = false;
        this.values = {
            num_retries: 2,
            allowed_fails: 3,
            cooldown_time: 120,
            rate_limit_fails_allowed: 5,
        };
        this.activePreset = 'balanced';
    }
    async mount(container) {
        this.container = document.createElement('div');
        this.container.className = 'h-full flex flex-col gap-4';
        container.appendChild(this.container);
        this._renderStatic();
        this._attachListeners();
        await this.loadConfig();
    }
    unmount() { }
    _renderStatic() {
        this.container.innerHTML = `
      <div class="flex justify-between items-center shrink-0">
        <div>
          <h1 class="text-xl font-bold text-white tracking-tight">Retry & Failures Policy</h1>
          <p class="text-sm text-zinc-400 mt-1">Configure fallbacks and cool-down timers inside the router</p>
        </div>
        <button id="retry-save" class="px-4 py-2.5 bg-gradient-to-r from-primary to-accentBlue text-white font-semibold rounded-xl text-sm transition shadow-lg flex items-center gap-2 disabled:opacity-50">
          <span style="width:16px;height:16px">${icons.check}</span>
          <span>Save Changes</span>
        </button>
      </div>

      <div class="shrink-0">
        <div class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Profile Presets</div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3" id="preset-grid">
          ${Object.entries(PRESETS)
            .map(([key, p]) => `
            <button class="mm-preset-btn ${this.activePreset === key ? 'active' : ''}" data-preset="${key}">
              <div class="font-semibold mb-0.5">${p.label}</div>
              <div class="text-[10px] text-zinc-500">${p.desc}</div>
            </button>
          `)
            .join('')}
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 flex-grow min-h-0 overflow-y-auto custom-scrollbar content-start">
        ${this._renderSlider('num_retries', 'Default Retries', 'Retries per fallback chain', 0, 10, 1)}
        ${this._renderSlider('allowed_fails', 'Allowed Failures', 'Consecutive fails to trigger cooldown', 0, 20, 1)}
        ${this._renderSlider('cooldown_time', 'Cooldown Period', 'Seconds a failed model is suspended', 0, 600, 10)}
        ${this._renderSlider('rate_limit_fails_allowed', 'Rate Limit Fails', 'Max HTTP 429 fails before cooldown', 0, 20, 1)}
      </div>
    `;
    }
    _renderSlider(key, label, desc, min, max, step) {
        const val = this.values[key];
        const unit = key === 'cooldown_time' ? 's' : '';
        return `
      <div class="bg-white/[0.01] border border-white/5 rounded-xl p-5 space-y-4">
        <div>
          <label class="block text-sm font-semibold text-white mb-1">${label}</label>
          <p class="text-xs text-zinc-400">${desc}</p>
        </div>
        <div class="flex items-center gap-4">
          <input type="range" id="slider-${key}" class="mm-slider flex-grow" min="${min}" max="${max}" step="${step}" value="${val}">
          <div class="flex items-center gap-2 min-w-[80px]">
            <input type="number" id="num-${key}" class="w-16 px-2 py-1.5 bg-zinc-900/50 border border-white/5 focus:border-primary/50 focus:outline-none rounded-lg text-sm text-zinc-200 text-center font-mono" min="${min}" max="${max}" value="${val}">
            <span class="text-xs text-zinc-500">${unit}</span>
          </div>
        </div>
        <div class="flex items-center justify-between text-[10px] text-zinc-600">
          <span>${min}</span>
          <span>${max}${unit}</span>
        </div>
      </div>
    `;
    }
    _attachListeners() {
        const keys = ['num_retries', 'allowed_fails', 'cooldown_time', 'rate_limit_fails_allowed'];
        for (const key of keys) {
            const slider = this.container.querySelector(`#slider-${key}`);
            const numInput = this.container.querySelector(`#num-${key}`);
            slider.addEventListener('input', () => {
                const val = parseInt(slider.value, 10);
                numInput.value = val;
                this.values[key] = val;
                this._detectPreset();
            });
            numInput.addEventListener('input', () => {
                let val = parseInt(numInput.value, 10);
                if (isNaN(val))
                    val = 0;
                val = Math.max(parseInt(slider.min, 10), Math.min(parseInt(slider.max, 10), val));
                slider.value = val;
                this.values[key] = val;
                this._detectPreset();
            });
        }
        this.container.querySelector('#preset-grid').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-preset]');
            if (!btn)
                return;
            const presetKey = btn.dataset.preset;
            const preset = PRESETS[presetKey];
            if (presetKey === 'custom') {
                this.activePreset = 'custom';
            }
            else {
                this.activePreset = presetKey;
                for (const key of keys) {
                    this.values[key] = preset[key];
                }
            }
            this._updateAllUI();
        });
        this.container.querySelector('#retry-save').addEventListener('click', () => this.saveConfig());
    }
    _detectPreset() {
        const keys = ['num_retries', 'allowed_fails', 'cooldown_time', 'rate_limit_fails_allowed'];
        for (const [pkey, preset] of Object.entries(PRESETS)) {
            if (pkey === 'custom')
                continue;
            const match = keys.every((k) => this.values[k] === preset[k]);
            if (match) {
                this.activePreset = pkey;
                this._updatePresetHighlight();
                return;
            }
        }
        this.activePreset = 'custom';
        this._updatePresetHighlight();
    }
    _updatePresetHighlight() {
        this.container.querySelectorAll('[data-preset]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.preset === this.activePreset);
        });
    }
    _updateAllUI() {
        const keys = ['num_retries', 'allowed_fails', 'cooldown_time', 'rate_limit_fails_allowed'];
        for (const key of keys) {
            const slider = this.container.querySelector(`#slider-${key}`);
            const numInput = this.container.querySelector(`#num-${key}`);
            if (slider)
                slider.value = this.values[key];
            if (numInput)
                numInput.value = this.values[key];
        }
        this._updatePresetHighlight();
    }
    async loadConfig() {
        try {
            const config = await this.api.get('/retry-config');
            if (config) {
                this.values = {
                    num_retries: config.num_retries,
                    allowed_fails: config.allowed_fails,
                    cooldown_time: config.cooldown_time,
                    rate_limit_fails_allowed: config.rate_limit_fails_allowed,
                };
                this._updateAllUI();
                this._detectPreset();
            }
        }
        catch (err) {
            ModelToast.show(`Failed to load retry config: ${err.message}`, 'error');
        }
    }
    async saveConfig() {
        if (this.isSubmitting)
            return;
        const saveBtn = this.container.querySelector('#retry-save');
        this.isSubmitting = true;
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<span class="mm-spin" style="width:16px;height:16px">${icons.spinner}</span> <span>Saving...</span>`;
        try {
            const res = await this.api.post('/retry-config', this.values);
            if (res && res.success) {
                ModelToast.show('Retry settings saved successfully', 'success');
            }
            else {
                throw new Error(res.error || 'Failed to save');
            }
        }
        catch (err) {
            ModelToast.show(`Error: ${err.message}`, 'error');
        }
        finally {
            this.isSubmitting = false;
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<span style="width:16px;height:16px">${icons.check}</span> <span>Save Changes</span>`;
        }
    }
}
