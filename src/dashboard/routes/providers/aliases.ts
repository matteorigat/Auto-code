import { Router, Request, Response, NextFunction } from 'express';
import { join } from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';

interface LitellmParams {
  model?: string;
  rpm?: number;
  timeout?: number;
}

interface ModelInfo {
  provider?: string;
  context_window?: number;
}

interface ModelEntry {
  model_name?: string;
  litellm_params?: LitellmParams;
  model_info?: ModelInfo;
}

interface ParsedConfig {
  model_list?: ModelEntry[];
  router_settings?: {
    fallbacks?: Record<string, string[]>[];
    context_window_fallbacks?: Record<string, string[]>[];
  };
}

interface FallbackModel {
  alias: string;
  model: string | null;
  rpm: number | null;
  timeout: number | null;
  context: number | null;
}

interface TierResult {
  tier: string;
  label: string;
  primary: {
    alias: string;
    model: string | null;
    rpm: number | null;
    timeout: number | null;
    context: number | null;
  } | null;
  fallbacks: FallbackModel[];
}

export function createAliasesRouter() {
  const router = Router();
  const CONFIG_DIR = join(process.cwd(), 'config');
  const TIER_NAMES = ['tier-4-planner', 'tier-3-builder', 'tier-2-hunter', 'tier-1-trivial'];
  const TIER_LABELS: Record<string, string> = {
    'tier-4-planner': 'High-complexity reasoning',
    'tier-3-builder': 'Fast tools-capable coding',
    'tier-2-hunter': 'QA and bug detection',
    'tier-1-trivial': 'Summarization and helpers',
  };

  router.get('/model-config', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const configPath = join(CONFIG_DIR, 'litellm.yaml');
      try {
        await access(configPath);
      } catch {
        return res.json([]);
      }

      const raw = await readFile(configPath, 'utf8');
      const parsed = parse(raw) as ParsedConfig;
      const modelList = parsed.model_list || [];

      const actualModels = modelList.filter(
        (m) => m && m.model_name && !m.model_name.startsWith('openai/tier-'),
      );

      res.json(actualModels);
    } catch (e) {
      next(e);
    }
  });

  router.get('/model-aliases', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const configPath = join(CONFIG_DIR, 'litellm.yaml');
      try {
        await access(configPath);
      } catch {
        return res.status(404).json({ error: 'litellm.yaml not found' });
      }

      const raw = await readFile(configPath, 'utf8');
      const parsed = parse(raw) as ParsedConfig;
      const modelList = parsed.model_list || [];
      const fallbacks = parsed.router_settings?.fallbacks || [];

      const tiers: TierResult[] = TIER_NAMES.map((tierName) => {
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
          (fb: Record<string, string[]>) => typeof fb === 'object' && fb !== null && fb[fullAlias],
        );
        const fbAliases: string[] = fbObj ? fbObj[fullAlias] : [];

        const fallbackModels: FallbackModel[] = fbAliases.map((fbAlias: string) => {
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

  router.post('/model-aliases', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        tier,
        fallbacks: newOrder,
        swapPrimaryWith,
        primaryModel,
      }: {
        tier?: string;
        fallbacks?: string[];
        swapPrimaryWith?: number;
        primaryModel?: string | null;
      } = req.body;
      if (!tier || !Array.isArray(newOrder)) {
        return res.status(400).json({ success: false, error: 'tier and fallbacks array required' });
      }

      const fullAlias = `openai/${tier}`;
      const configPath = join(CONFIG_DIR, 'litellm.yaml');
      const raw = await readFile(configPath, 'utf8');
      const parsed = parse(raw) as ParsedConfig;

      if (!parsed.router_settings) parsed.router_settings = {};
      if (!parsed.router_settings.fallbacks) parsed.router_settings.fallbacks = [];

      parsed.router_settings.fallbacks = parsed.router_settings.fallbacks.filter(
        (fb: Record<string, string[]>) => !(typeof fb === 'object' && fb !== null && fb[fullAlias]),
      );

      if (newOrder.length > 0) {
        parsed.router_settings.fallbacks.push({ [fullAlias]: newOrder });
      }

      if (parsed.router_settings.context_window_fallbacks) {
        parsed.router_settings.context_window_fallbacks =
          parsed.router_settings.context_window_fallbacks.filter(
            (entry: Record<string, string[]>) =>
              !(typeof entry === 'object' && entry !== null && entry[fullAlias]),
          );
        const cwfAliases = newOrder.filter((a) => a.includes('-fb'));
        if (cwfAliases.length > 0) {
          parsed.router_settings.context_window_fallbacks.push({ [fullAlias]: cwfAliases });
        }
      }

      if (swapPrimaryWith !== undefined && swapPrimaryWith >= 0 && primaryModel) {
        const primaryEntry = (parsed.model_list || []).find((m) => m.model_name === fullAlias);
        const fbAlias = newOrder[swapPrimaryWith];
        const fbEntry = (parsed.model_list || []).find((m) => m.model_name === fbAlias);
        if (primaryEntry && fbEntry && primaryEntry.litellm_params && fbEntry.litellm_params) {
          fbEntry.litellm_params.model = primaryEntry.litellm_params.model;
          primaryEntry.litellm_params.model = primaryModel;
        } else if (fbEntry && !primaryEntry) {
          if (!parsed.model_list) parsed.model_list = [];
          parsed.model_list.push({
            model_name: fullAlias,
            litellm_params: { model: primaryModel },
            model_info: { provider: primaryModel.split('/')[0] || 'unknown' },
          });
        }
      } else if (primaryModel) {
        const primaryEntry = (parsed.model_list || []).find((m) => m.model_name === fullAlias);
        if (!primaryEntry) {
          if (!parsed.model_list) parsed.model_list = [];
          parsed.model_list.push({
            model_name: fullAlias,
            litellm_params: { model: primaryModel },
            model_info: { provider: primaryModel.split('/')[0] || 'unknown' },
          });
        } else if (primaryEntry.litellm_params) {
          primaryEntry.litellm_params.model = primaryModel;
        }
      } else {
        parsed.model_list = (parsed.model_list || []).filter((m) => m.model_name !== fullAlias);
      }

      const allTiers = ['tier-4-planner', 'tier-3-builder', 'tier-2-hunter', 'tier-1-trivial'];
      const referenced = new Set<string>();
      allTiers.forEach((t) => referenced.add(`openai/${t}`));
      (parsed.router_settings.fallbacks || []).forEach((fb: Record<string, string[]>) => {
        if (fb && typeof fb === 'object')
          Object.values(fb).forEach((list: string[]) => {
            if (Array.isArray(list)) list.forEach((a: string) => referenced.add(a));
          });
      });
      (parsed.router_settings.context_window_fallbacks || []).forEach(
        (fb: Record<string, string[]>) => {
          if (fb && typeof fb === 'object')
            Object.values(fb).forEach((list: string[]) => {
              if (Array.isArray(list)) list.forEach((a: string) => referenced.add(a));
            });
        },
      );
      const seen = new Set<string>();
      parsed.model_list = (parsed.model_list || []).filter((m) => {
        if (!m || !m.model_name) return false;
        if (m.model_name.startsWith('openai/tier-')) {
          if (!referenced.has(m.model_name) || seen.has(m.model_name)) return false;
          seen.add(m.model_name);
          return true;
        }
        if (seen.has(m.model_name)) return false;
        seen.add(m.model_name);
        return true;
      });

      const yaml = stringify(parsed);
      await writeFile(configPath, yaml, 'utf8');

      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/model-aliases/add', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tier, model }: { tier?: string; model?: string } = req.body;
      if (!tier || !model) {
        return res.status(400).json({ success: false, error: 'tier and model required' });
      }

      const fullAlias = `openai/${tier}`;
      const configPath = join(CONFIG_DIR, 'litellm.yaml');
      const raw = await readFile(configPath, 'utf8');
      const parsed = parse(raw) as ParsedConfig;

      const fallbacks = parsed.router_settings?.fallbacks || [];
      const fbObj = fallbacks.find(
        (fb: Record<string, string[]>) => typeof fb === 'object' && fb !== null && fb[fullAlias],
      );
      const existingAliases: string[] = fbObj ? fbObj[fullAlias] : [];

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
        (fb: Record<string, string[]>) => !(typeof fb === 'object' && fb !== null && fb[fullAlias]),
      );
      parsed.router_settings.fallbacks.push({ [fullAlias]: [...existingAliases, newAlias] });

      const yaml = stringify(parsed);
      await writeFile(configPath, yaml, 'utf8');

      res.json({ success: true, alias: newAlias });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
