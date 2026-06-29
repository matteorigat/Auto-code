import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { getQuotaManager } from './quota-manager.js';
import config from '../config/index.js';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..', '..');
const PHASE_TIER_MAP = {
    PLAN: 'tier-4-planner',
    DISCOVER: 'tier-4-planner',
    EXEC: 'tier-3-builder',
    SWARM: 'tier-3-builder',
    FIX: 'tier-2-hunter',
    QA: 'tier-2-hunter',
    VISUAL_QA: 'tier-2-hunter',
    REFLECT: 'tier-2-hunter',
    COMMIT: 'tier-1-trivial',
    SYNC: 'tier-1-trivial',
    IDLE: 'tier-1-trivial',
};
const AGENT_TYPE_TIER_MAP = {
    builder: 'tier-3-builder',
    architect: 'tier-4-planner',
    reviewer: 'tier-3-builder',
    patcher: 'tier-2-hunter',
    'visual-reviewer': 'tier-2-hunter',
    'bug-hunter': 'tier-4-planner',
    innovator: 'tier-4-planner',
    orchestrator: 'tier-4-planner',
    'project-planner': 'tier-4-planner',
    'skill-extractor': 'tier-2-hunter',
    summarizer: 'tier-1-trivial',
};
const TIER_PRIORITY = ['tier-4-planner', 'tier-3-builder', 'tier-2-hunter', 'tier-1-trivial'];
export class TierSelector {
    quotaManager;
    configPath;
    _tierProviders;
    constructor({ quotaManager, configPath, } = {}) {
        this.quotaManager = quotaManager || getQuotaManager();
        this.configPath = configPath || join(ROOT, 'config', 'provider-quota.yaml');
        this._tierProviders = null;
    }
    _loadTierProviders() {
        if (this._tierProviders)
            return;
        if (!existsSync(this.configPath)) {
            this._tierProviders = {};
            return;
        }
        const raw = readFileSync(this.configPath, 'utf-8');
        const parsed = parse(raw);
        const map = {};
        for (const [name, p] of Object.entries(parsed.providers || {})) {
            for (const m of p.models || []) {
                const parts = m.id.split('/'); // e.g. "openai/tier-4-planner-fb2"
                const tierKey = parts.length >= 2 ? parts[1] : null;
                if (!tierKey)
                    continue;
                const baseTier = tierKey.split('-fb')[0]; // "tier-4-planner"
                if (!map[baseTier])
                    map[baseTier] = {};
                if (!map[baseTier][name])
                    map[baseTier][name] = [];
                map[baseTier][name].push(m);
            }
        }
        this._tierProviders = map;
    }
    tierForPhase(phase) {
        return PHASE_TIER_MAP[phase] || 'tier-4-planner';
    }
    tierForAgentType(agentType) {
        return AGENT_TYPE_TIER_MAP[agentType] || 'tier-3-builder';
    }
    hasQuotaForTier(tier) {
        if (!this.quotaManager)
            return true;
        this._loadTierProviders();
        const providers = this._tierProviders?.[tier];
        if (!providers)
            return true;
        for (const [providerName, models] of Object.entries(providers)) {
            for (const m of models) {
                if (this.quotaManager.canUse(providerName, { model: m.id })) {
                    return true;
                }
            }
        }
        return false;
    }
    select(phase) {
        const ideal = this.tierForPhase(phase);
        const startIdx = TIER_PRIORITY.indexOf(ideal);
        if (startIdx === -1)
            return ideal;
        if (!this.quotaManager)
            return ideal;
        for (let i = startIdx; i < TIER_PRIORITY.length; i++) {
            const tier = TIER_PRIORITY[i];
            if (this.hasQuotaForTier(tier)) {
                if (tier !== ideal) {
                    console.warn(`[TierSelector] ⚠️ ${ideal} quota esaurita, downgrade a ${tier} per ${phase}`);
                }
                return tier;
            }
        }
        const last = TIER_PRIORITY[TIER_PRIORITY.length - 1];
        console.warn(`[TierSelector] ⚠️ Tutti i tier superiori esauriti, forzato a ${last} per ${phase}`);
        return last;
    }
    selectByAgentType(agentType) {
        const ideal = this.tierForAgentType(agentType);
        const startIdx = TIER_PRIORITY.indexOf(ideal);
        if (startIdx === -1)
            return ideal;
        if (!this.quotaManager)
            return ideal;
        for (let i = startIdx; i < TIER_PRIORITY.length; i++) {
            const tier = TIER_PRIORITY[i];
            if (this.hasQuotaForTier(tier)) {
                if (tier !== ideal) {
                    console.warn(`[TierSelector] ⚠️ ${ideal} quota esaurita, downgrade a ${tier} per agentType ${agentType}`);
                }
                return tier;
            }
        }
        const last = TIER_PRIORITY[TIER_PRIORITY.length - 1];
        console.warn(`[TierSelector] ⚠️ Tutti i tier superiori esauriti, forzato a ${last} per agentType ${agentType}`);
        return last;
    }
    applyTierConfig(tier, projectPath) {
        const configPath = join(projectPath, '.opencode', 'opencode.json');
        let existing = {};
        if (existsSync(configPath)) {
            try {
                existing = JSON.parse(readFileSync(configPath, 'utf-8'));
            }
            catch {
                /* ignore */
            }
        }
        const apiKey = config.omniroute.apiKey;
        const omnirouteUrl = config.omniroute.url;
        let provider = existing.provider;
        if (provider) {
            for (const prov of Object.values(provider)) {
                if (!prov.options)
                    prov.options = {};
                if (!prov.options.apiKey)
                    prov.options.apiKey = apiKey;
                if (!prov.apiKey)
                    prov.apiKey = apiKey;
            }
            if (provider.openai) {
                if (!provider.openai.options)
                    provider.openai.options = {};
                provider.openai.options.baseURL = `${omnirouteUrl}/v1`;
            }
        }
        else {
            provider = {
                openai: {
                    apiKey,
                    options: {
                        baseURL: `${omnirouteUrl}/v1`,
                        headerTimeout: 120000,
                        timeout: 180000,
                    },
                },
            };
        }
        // Map custom tiers to OmniRoute auto-routing model names
        const tierToModel = {
            'tier-4-planner': 'auto/best-reasoning',
            'tier-3-builder': 'auto/best-coding',
            'tier-2-hunter': 'auto/best-coding',
            'tier-1-trivial': 'auto/fast',
        };
        const mappedModel = tierToModel[tier] || 'auto/best-coding';
        const allModels = Object.values(tierToModel);
        const prov = (provider ?? {});
        if (!prov.openai)
            prov.openai = {};
        prov.openai.models = {};
        for (const m of allModels) {
            prov.openai.models[m] = {
                id: m,
                limit: { context: 128000, output: 8192 },
            };
        }
        const opencodeConfig = {
            $schema: existing.$schema || 'https://opencode.ai/config.json',
            permission: existing.permission || 'allow',
            model: `openai/${mappedModel}`,
            fallbacks: existing.fallbacks,
            cooldown_seconds: existing.cooldown_seconds,
            small_model: existing.small_model,
            compaction: existing.compaction || { auto: true, prune: true, reserved: 30000 },
            provider,
            agent: existing.agent,
        };
        const configDir = dirname(configPath);
        if (!existsSync(configDir)) {
            mkdirSync(configDir, { recursive: true });
        }
        writeFileSync(configPath, JSON.stringify(opencodeConfig, null, 2) + '\n');
        console.log(`[TierSelector] set model=${opencodeConfig.model} for ${projectPath}`);
    }
}
