import { Router } from 'express';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

export function createAliasesRouter() {
  const router = Router();
  const CONFIG_DIR = join(process.cwd(), 'config');
  const TIER_NAMES = ['tier-4-planner', 'tier-3-builder', 'tier-2-hunter', 'tier-1-trivial'];
  const TIER_LABELS = {
    'tier-4-planner': 'High-complexity reasoning',
    'tier-3-builder': 'Fast tools-capable coding',
    'tier-2-hunter': 'QA and bug detection',
    'tier-1-trivial': 'Summarization and helpers',
  };

  router.get('/model-aliases', (req, res, next) => {
    try {
      const configPath = join(CONFIG_DIR, 'litellm.yaml');
      if (!existsSync(configPath)) return res.status(404).json({ error: 'litellm.yaml not found' });

      const raw = readFileSync(configPath, 'utf8');
      const parsed = parse(raw);
      const modelList = parsed.model_list || [];
      const fallbacks = parsed.router_settings?.fallbacks || [];

      const tiers = TIER_NAMES.map((tierName) => {
        const fullAlias = `openai/${tierName}`;
        const primaryEntry = modelList.find((m) => m.model_name === fullAlias);
        const primary = primaryEntry
          ? {
              alias: fullAlias,
              model: primaryEntry.litellm_params?.model || null,
              rpm: primaryEntry.litellm_params?.rpm || null,
              timeout: primaryEntry.litellm_params?.timeout || null,
              context: primaryEntry.model_info?.context_window || null,
            }
          : null;

        const fbObj = fallbacks.find(
          (fb) => typeof fb === 'object' && fb !== null && fb[fullAlias],
        );
        const fbAliases = fbObj ? fbObj[fullAlias] : [];

        const fallbackModels = fbAliases.map((fbAlias) => {
          const entry = modelList.find((m) => m.model_name === fbAlias);
          return {
            alias: fbAlias,
            model: entry?.litellm_params?.model || fbAlias,
            rpm: entry?.litellm_params?.rpm || null,
            timeout: entry?.litellm_params?.timeout || null,
            context: entry?.model_info?.context_window || null,
          };
        });

        return {
          tier: tierName,
          label: TIER_LABELS[tierName] || '',
          primary,
          fallbacks: fallbackModels,
        };
      });

      res.json(tiers);
    } catch (e) {
      next(e);
    }
  });

  router.post('/model-aliases', (req, res, next) => {
    try {
      const { tier, fallbacks: newOrder, swapPrimaryWith, primaryModel } = req.body;
      if (!tier || !Array.isArray(newOrder)) {
        return res.status(400).json({ success: false, error: 'tier and fallbacks array required' });
      }

      const fullAlias = `openai/${tier}`;
      const configPath = join(CONFIG_DIR, 'litellm.yaml');
      const raw = readFileSync(configPath, 'utf8');
      const parsed = parse(raw);

      if (!parsed.router_settings) parsed.router_settings = {};
      if (!parsed.router_settings.fallbacks) parsed.router_settings.fallbacks = [];

      parsed.router_settings.fallbacks = parsed.router_settings.fallbacks.filter(
        (fb) => !(typeof fb === 'object' && fb !== null && fb[fullAlias]),
      );

      if (newOrder.length > 0) {
        parsed.router_settings.fallbacks.push({ [fullAlias]: newOrder });
      }

      if (parsed.router_settings.context_window_fallbacks) {
        parsed.router_settings.context_window_fallbacks =
          parsed.router_settings.context_window_fallbacks.filter(
            (entry) => !(typeof entry === 'object' && entry !== null && entry[fullAlias]),
          );
        const cwfAliases = newOrder.filter((a) => a.includes('-fb'));
        if (cwfAliases.length > 0) {
          parsed.router_settings.context_window_fallbacks.push({ [fullAlias]: cwfAliases });
        }
      }

      if (swapPrimaryWith !== undefined && primaryModel !== null) {
        const primaryEntry = (parsed.model_list || []).find((m) => m.model_name === fullAlias);
        const fbAlias = newOrder[swapPrimaryWith];
        const fbEntry = (parsed.model_list || []).find((m) => m.model_name === fbAlias);
        if (primaryEntry && fbEntry) {
          fbEntry.litellm_params.model = primaryEntry.litellm_params.model;
          primaryEntry.litellm_params.model = primaryModel;
        }
      }

      const allTiers = ['tier-4-planner', 'tier-3-builder', 'tier-2-hunter', 'tier-1-trivial'];
      const referenced = new Set();
      allTiers.forEach((t) => referenced.add(`openai/${t}`));
      (parsed.router_settings.fallbacks || []).forEach((fb) => {
        if (fb && typeof fb === 'object')
          Object.values(fb).forEach((list) => {
            if (Array.isArray(list)) list.forEach((a) => referenced.add(a));
          });
      });
      (parsed.router_settings.context_window_fallbacks || []).forEach((fb) => {
        if (fb && typeof fb === 'object')
          Object.values(fb).forEach((list) => {
            if (Array.isArray(list)) list.forEach((a) => referenced.add(a));
          });
      });
      const seen = new Set();
      parsed.model_list = (parsed.model_list || []).filter((m) => {
        if (!referenced.has(m.model_name) || seen.has(m.model_name)) return false;
        seen.add(m.model_name);
        return true;
      });

      const yaml = stringify(parsed);
      writeFileSync(configPath, yaml, 'utf8');

      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/model-aliases/add', (req, res, next) => {
    try {
      const { tier, model } = req.body;
      if (!tier || !model) {
        return res.status(400).json({ success: false, error: 'tier and model required' });
      }

      const fullAlias = `openai/${tier}`;
      const configPath = join(CONFIG_DIR, 'litellm.yaml');
      const raw = readFileSync(configPath, 'utf8');
      const parsed = parse(raw);

      const fallbacks = parsed.router_settings?.fallbacks || [];
      const fbObj = fallbacks.find((fb) => typeof fb === 'object' && fb !== null && fb[fullAlias]);
      const existingAliases = fbObj ? fbObj[fullAlias] : [];

      let maxNum = 0;
      for (const a of existingAliases) {
        const match = a.match(/-fb(\d+)$/);
        if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
      }
      const newNum = maxNum + 1;
      const newAlias = `${fullAlias}-fb${newNum}`;

      if (!parsed.model_list) parsed.model_list = [];
      parsed.model_list.push({
        model_name: newAlias,
        litellm_params: { model },
        model_info: { provider: model.split('/')[0] || 'unknown' },
      });

      if (!parsed.router_settings) parsed.router_settings = {};
      if (!parsed.router_settings.fallbacks) parsed.router_settings.fallbacks = [];

      parsed.router_settings.fallbacks = parsed.router_settings.fallbacks.filter(
        (fb) => !(typeof fb === 'object' && fb !== null && fb[fullAlias]),
      );
      parsed.router_settings.fallbacks.push({ [fullAlias]: [...existingAliases, newAlias] });

      const yaml = stringify(parsed);
      writeFileSync(configPath, yaml, 'utf8');

      res.json({ success: true, alias: newAlias });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
