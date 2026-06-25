import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { getAppBus } from './app-bus.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..', '..');

const NOW = () => Date.now();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let _sharedInstance = null;

export function getQuotaManager(configPath) {
  if (!_sharedInstance) {
    _sharedInstance = new QuotaManager(configPath);
  }
  return _sharedInstance;
}

export class QuotaManager {
  constructor(configPath) {
    this.configPath = configPath || join(ROOT, 'config', 'provider-quota.yaml');
    this._providers = {}; // provider config from file
    this._windows = {}; // sliding-window usage counters
    this._cooldowns = {}; // provider cooldown timestamps
    this._loaded = false;
  }

  load() {
    if (this._loaded) return;
    if (!existsSync(this.configPath)) {
      console.warn('[QuotaManager] config not found at', this.configPath);
      this._loaded = true;
      return;
    }
    const raw = readFileSync(this.configPath, 'utf-8');
    const parsed = parse(raw);
    for (const [name, p] of Object.entries(parsed.providers)) {
      this._providers[name] = p;
      this._windows[name] = { rpm: [], rph: [], rpd: [], rphMs: (p.rphPeriod || 1) * HOUR };
      this._cooldowns[name] = 0;
    }
    this._loaded = true;
    console.log(`[QuotaManager] loaded ${Object.keys(this._providers).length} providers`);
  }

  _getProviderKey(providerName) {
    return Object.keys(this._providers).find(
      (k) => k === providerName || providerName.startsWith(k),
    );
  }

  reportUsage(providerName, { model, tokens } = {}) {
    this.load();
    const key = this._getProviderKey(providerName);
    if (!key) return;
    const cfg = this._providers[key];
    const now = NOW();

    if (cfg.type === 'per-model' && model) {
      const modelCfg = cfg.models?.find((m) => m.id === model || m.upstream === model);
      if (modelCfg) {
        this._windows[`${key}:${modelCfg.id}`] = this._windows[`${key}:${modelCfg.id}`] || {
          rpm: [],
          rph: [],
          rpd: [],
          rphMs: (cfg.rphPeriod || 1) * HOUR,
        };
        this._windows[`${key}:${modelCfg.id}`].rpm.push(now);
        this._windows[`${key}:${modelCfg.id}`].rph.push(now);
        this._windows[`${key}:${modelCfg.id}`].rpd.push(now);
      }
    } else {
      this._windows[key].rpm.push(now);
      this._windows[key].rph.push(now);
      this._windows[key].rpd.push(now);
    }

    this._prune(key);
  }

  _prune(providerKey) {
    const now = NOW();
    for (const wkey of Object.keys(this._windows)) {
      if (!wkey.startsWith(providerKey)) continue;
      const w = this._windows[wkey];
      if (w) {
        w.rpm = w.rpm.filter((t) => now - t < MIN);
        w.rph = w.rph.filter((t) => now - t < (w.rphMs || HOUR));
        w.rpd = w.rpd.filter((t) => now - t < DAY);
      }
    }
  }

  _count(key, windowKey) {
    const w = this._windows[key];
    if (!w) return 0;
    return w[windowKey]?.length || 0;
  }

  canUse(providerName, { model } = {}) {
    this.load();
    const key = this._getProviderKey(providerName);
    if (!key) return false;
    const cfg = this._providers[key];

    if (this._cooldowns[key] > NOW()) return false;

    if (cfg.type === 'opportunistic') return true;

    if (cfg.type === 'per-model' && model) {
      const modelCfg = cfg.models?.find((m) => m.id === model || m.upstream === model);
      if (!modelCfg) return false;
      const mkey = `${key}:${modelCfg.id}`;
      if (modelCfg.rpm && this._count(mkey, 'rpm') >= modelCfg.rpm) return false;
      if (modelCfg.rph && this._count(mkey, 'rph') >= modelCfg.rph) return false;
      if (modelCfg.rpd && this._count(mkey, 'rpd') >= modelCfg.rpd) return false;
      return true;
    }

    if (cfg.rpm && this._count(key, 'rpm') >= cfg.rpm) return false;
    if (cfg.rph && this._count(key, 'rph') >= cfg.rph) return false;
    if (cfg.rpd && this._count(key, 'rpd') >= cfg.rpd) return false;

    return true;
  }

  getBestAvailable(tierModels) {
    for (const entry of tierModels) {
      const { modelName, provider } = entry;
      if (this.canUse(provider, { model: modelName })) {
        return modelName;
      }
    }
    return null;
  }

  recordCooldown(providerName, durationMs = 60000) {
    const key = this._getProviderKey(providerName);
    if (!key) return;
    this._cooldowns[key] = NOW() + durationMs;
    console.warn(`[QuotaManager] ${key} cooldown for ${durationMs}ms`);
    const bus = getAppBus();
    bus.telemetry('cooldown.started', 'quota', `${key} cooldown for ${durationMs}ms`, {
      level: 'warn',
      data: { provider: key, durationMs, reason: 'rate_limit' },
    });
  }

  getStatus() {
    this.load();
    const status = {};
    for (const [key, cfg] of Object.entries(this._providers)) {
      this._prune(key);
      const inCooldown = this._cooldowns[key] > NOW();
      const cooldownRemaining = Math.max(0, this._cooldowns[key] - NOW());
      let rpmUsed = 0,
        rphUsed = 0,
        rpdUsed = 0;

      if (cfg.type === 'per-model') {
        const models = {};
        for (const m of cfg.models || []) {
          const mkey = `${key}:${m.id}`;
          models[m.id] = {
            upstream: m.upstream,
            rpmUsed: this._count(mkey, 'rpm'),
            rpmLimit: m.rpm || null,
            rphUsed: this._count(mkey, 'rph'),
            rphLimit: m.rph || null,
            rpdUsed: this._count(mkey, 'rpd'),
            rpdLimit: m.rpd || null,
          };
        }
        status[key] = {
          type: cfg.type,
          inCooldown,
          cooldownRemaining,
          models,
        };
      } else {
        rpmUsed = this._count(key, 'rpm');
        rphUsed = this._count(key, 'rph');
        rpdUsed = this._count(key, 'rpd');
        status[key] = {
          type: cfg.type,
          inCooldown,
          cooldownRemaining,
          rpmUsed,
          rpmLimit: cfg.rpm || null,
          rphUsed,
          rphLimit: cfg.rph || null,
          rphPeriod: cfg.rphPeriod || 1,
          rpdUsed,
          rpdLimit: cfg.rpd || null,
        };
      }
    }
    return status;
  }
}
