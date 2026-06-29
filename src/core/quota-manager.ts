import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { getAppBus } from './app-bus.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..', '..');

const NOW = () => Date.now();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface QuotaProviderModel {
  id: string;
  upstream: string;
  rpm?: number;
  rph?: number;
  rpd?: number;
}

export interface QuotaProvider {
  type: 'opportunistic' | 'per-model' | 'global';
  rpm?: number;
  rph?: number;
  rphPeriod?: number;
  rpd?: number;
  models?: QuotaProviderModel[];
}

export interface SlidingWindow {
  rpm: number[];
  rph: number[];
  rpd: number[];
  rphMs: number;
}

interface PerModelStatus {
  upstream: string;
  rpmUsed: number;
  rpmLimit: number | null;
  rphUsed: number;
  rphLimit: number | null;
  rpdUsed: number;
  rpdLimit: number | null;
}

interface QuotaProviderStatus {
  type: string;
  inCooldown: boolean;
  cooldownRemaining: number;
  models?: Record<string, PerModelStatus>;
  rpmUsed?: number;
  rpmLimit?: number | null;
  rphUsed?: number;
  rphLimit?: number | null;
  rphPeriod?: number;
  rpdUsed?: number;
  rpdLimit?: number | null;
}

let _sharedInstance: QuotaManager | null = null;

export function getQuotaManager(configPath?: string): QuotaManager {
  if (!_sharedInstance) {
    _sharedInstance = new QuotaManager(configPath);
  }
  return _sharedInstance;
}

export class QuotaManager {
  configPath: string;
  _providers: Record<string, QuotaProvider>;
  _windows: Record<string, SlidingWindow>;
  _cooldowns: Record<string, number>;
  _loaded: boolean;

  constructor(configPath?: string) {
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
    for (const [name, p] of Object.entries(parsed.providers || {}) as [string, QuotaProvider][]) {
      this._providers[name] = p;
      this._windows[name] = { rpm: [], rph: [], rpd: [], rphMs: (p.rphPeriod || 1) * HOUR };
      this._cooldowns[name] = 0;
    }
    this._loaded = true;
    console.log(`[QuotaManager] loaded ${Object.keys(this._providers).length} providers`);
  }

  _getProviderKey(providerName: string): string | undefined {
    return Object.keys(this._providers).find(
      (k) => k === providerName || providerName.startsWith(k),
    );
  }

  reportUsage(
    providerName: string,
    { model, tokens: _tokens }: { model?: string; tokens?: number } = {},
  ) {
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

  _prune(providerKey: string) {
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

  _count(key: string, windowKey: 'rpm' | 'rph' | 'rpd'): number {
    const w = this._windows[key];
    if (!w) return 0;
    return w[windowKey]?.length || 0;
  }

  canUse(providerName: string, { model }: { model?: string } = {}): boolean {
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

  getBestAvailable(tierModels: Array<{ modelName: string; provider: string }>): string | null {
    for (const entry of tierModels) {
      const { modelName, provider } = entry;
      if (this.canUse(provider, { model: modelName })) {
        return modelName;
      }
    }
    return null;
  }

  recordCooldown(providerName: string, durationMs: number = 60000) {
    const key = this._getProviderKey(providerName);
    if (!key) return;
    this._cooldowns[key] = NOW() + durationMs;
    console.warn(`[QuotaManager] ${key} cooldown for ${durationMs}ms`);
    const bus = getAppBus();
    bus.telemetry('log', 'quota', `${key} cooldown for ${durationMs}ms`, {
      level: 'warn',
      data: { provider: key, durationMs, reason: 'rate_limit' },
    });
  }

  getStatus(): Record<string, QuotaProviderStatus> {
    this.load();
    const status: Record<string, QuotaProviderStatus> = {};
    for (const [key, cfg] of Object.entries(this._providers)) {
      this._prune(key);
      const inCooldown = this._cooldowns[key] > NOW();
      const cooldownRemaining = Math.max(0, this._cooldowns[key] - NOW());

      if (cfg.type === 'per-model') {
        const models: Record<string, PerModelStatus> = {};
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
        const rpmUsed = this._count(key, 'rpm');
        const rphUsed = this._count(key, 'rph');
        const rpdUsed = this._count(key, 'rpd');
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
