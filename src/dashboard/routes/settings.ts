import { Router, Request, Response, NextFunction } from 'express';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { AppConfig } from '../../config/index.js';

const CONFIG_DIR = join(process.cwd(), 'config');

interface RouterDeps {
  config: AppConfig;
}

function readLitellmYaml(): Record<string, unknown> {
  const configPath = join(CONFIG_DIR, 'litellm.yaml');
  if (!existsSync(configPath)) {
    const err = new Error('litellm.yaml not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const raw = readFileSync(configPath, 'utf8');
  return parse(raw) as Record<string, unknown>;
}

function writeLitellmYaml(parsed: Record<string, unknown>): void {
  const configPath = join(CONFIG_DIR, 'litellm.yaml');
  writeFileSync(configPath, stringify(parsed), 'utf8');
}

const PROVIDER_KEYS: { id: string; label: string; envKey: string }[] = [
  { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY' },
  { id: 'groq', label: 'Groq', envKey: 'GROQ_API_KEY' },
  { id: 'mistral', label: 'Mistral AI', envKey: 'MISTRAL_API_KEY' },
  { id: 'cerebras', label: 'Cerebras', envKey: 'CEREBRAS_API_KEY' },
  { id: 'kilo', label: 'Kilo Gateway', envKey: 'KILO_API_KEY' },
  { id: 'nvidia_nim', label: 'Nvidia NIM', envKey: 'NVIDIA_API_KEY' },
  { id: 'opencode', label: 'OpenCode', envKey: 'OPENCODE_API_KEY' },
  { id: 'ollama', label: 'Ollama', envKey: 'OLLAMA_API_KEY' },
];

export function createSettingsRouter({ config }: RouterDeps) {
  const router = Router();

  router.get('/retry-config', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = readLitellmYaml();
      const rs = (parsed.router_settings || {}) as Record<string, unknown>;
      res.json({
        num_retries: rs.num_retries ?? 2,
        allowed_fails: rs.allowed_fails ?? 3,
        cooldown_time: rs.cooldown_time ?? 120,
        rate_limit_fails_allowed: rs.rate_limit_fails_allowed ?? 5,
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/model-credentials', (req: Request, res: Response) => {
    const creds = PROVIDER_KEYS.map((p) => ({
      ...p,
      configured: !!(
        process.env[p.envKey] || (config.litellm?.providerKeys as Record<string, string>)?.[p.id]
      ),
    }));
    res.json(creds);
  });

  router.get('/model-endpoints', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = readLitellmYaml();
      const list = ((parsed.model_list || []) as Record<string, unknown>[]).map(
        (m: Record<string, unknown>) => ({
          model_name: m.model_name,
          provider: ((m.litellm_params as Record<string, unknown>)?.model as string) || '-',
          api_base: (m.litellm_params as Record<string, unknown>)?.api_base || '-',
          tier: m.model_name || '-',
        }),
      );
      res.json(list);
    } catch (e) {
      next(e);
    }
  });

  router.post('/model-price-reload', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = readLitellmYaml();
      const genericLog =
        ((parsed.general_settings as Record<string, unknown>)?.database_pool_size as number) || 0;
      res.json({
        status: 'ok',
        modelCount: ((parsed.model_list || []) as unknown[]).length,
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
