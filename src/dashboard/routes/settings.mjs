import { Router } from 'express';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const CONFIG_DIR = join(process.cwd(), 'config');

function readLitellmYaml() {
  const configPath = join(CONFIG_DIR, 'litellm.yaml');
  if (!existsSync(configPath)) {
    const err = new Error('litellm.yaml not found');
    err.status = 404;
    throw err;
  }
  const raw = readFileSync(configPath, 'utf8');
  return parse(raw);
}

function writeLitellmYaml(parsed) {
  const configPath = join(CONFIG_DIR, 'litellm.yaml');
  writeFileSync(configPath, stringify(parsed), 'utf8');
}

const PROVIDER_KEYS = [
  { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY' },
  { id: 'groq', label: 'Groq', envKey: 'GROQ_API_KEY' },
  { id: 'mistral', label: 'Mistral AI', envKey: 'MISTRAL_API_KEY' },
  { id: 'cerebras', label: 'Cerebras', envKey: 'CEREBRAS_API_KEY' },
  { id: 'kilo', label: 'Kilo Gateway', envKey: 'KILO_API_KEY' },
  { id: 'nvidia_nim', label: 'Nvidia NIM', envKey: 'NVIDIA_API_KEY' },
  { id: 'opencode', label: 'OpenCode', envKey: 'OPENCODE_API_KEY' },
  { id: 'ollama', label: 'Ollama', envKey: 'OLLAMA_API_KEY' },
];

export function createSettingsRouter({ config }) {
  const router = Router();

  router.get('/retry-config', (req, res, next) => {
    try {
      const parsed = readLitellmYaml();
      const rs = parsed.router_settings || {};
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

  router.post('/retry-config', (req, res, next) => {
    try {
      const { num_retries, allowed_fails, cooldown_time, rate_limit_fails_allowed } = req.body;
      const parsed = readLitellmYaml();
      if (!parsed.router_settings) parsed.router_settings = {};
      if (num_retries !== undefined) parsed.router_settings.num_retries = num_retries;
      if (allowed_fails !== undefined) parsed.router_settings.allowed_fails = allowed_fails;
      if (cooldown_time !== undefined) parsed.router_settings.cooldown_time = cooldown_time;
      if (rate_limit_fails_allowed !== undefined)
        parsed.router_settings.rate_limit_fails_allowed = rate_limit_fails_allowed;
      writeLitellmYaml(parsed);
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });

  router.get('/model-credentials', (req, res) => {
    res.json(
      PROVIDER_KEYS.map((p) => {
        const raw = process.env[p.envKey] || config.litellm.providerKeys[p.id] || '';
        return {
          provider: p.label,
          id: p.id,
          keyName: p.envKey,
          masked: raw ? raw.substring(0, 8) + '...' + raw.slice(-4) : '',
          status: raw ? 'Active' : 'Missing',
          source: raw ? 'env' : '',
        };
      }),
    );
  });

  router.get('/model-endpoints', async (req, res) => {
    const litellmKey = config.litellm.masterKey;
    const base = 'http://127.0.0.1:4000';

    const defaultEndpoints = [
      {
        name: 'Chat Completions',
        path: '/v1/chat/completions',
        status: 'info',
        details: 'OpenAI-compatible chat API',
      },
      {
        name: 'Models List',
        path: '/v1/models',
        status: 'info',
        details: 'List configured models',
      },
      {
        name: 'Add Model',
        path: '/model/new',
        status: 'info',
        details: 'Add model to runtime config',
      },
      {
        name: 'Delete Model',
        path: '/model/delete',
        status: 'info',
        details: 'Remove model from runtime config',
      },
      { name: 'Health', path: '/health', status: 'info', details: 'LiteLLM proxy health check' },
    ];

    try {
      const healthRes = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      defaultEndpoints[4].status = healthRes.ok ? 'Healthy' : 'Error';
      defaultEndpoints[4].details = healthRes.ok
        ? 'Proxy is reachable'
        : `HTTP ${healthRes.status}`;

      const modelsRes = await fetch(`${base}/v1/models`, {
        headers: { Authorization: `Bearer ${litellmKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (modelsRes.ok) {
        defaultEndpoints[1].status = 'Healthy';
        defaultEndpoints[1].details = 'Models endpoint reachable';
      }
    } catch (e) {
      defaultEndpoints[0].status = 'Error';
      defaultEndpoints[0].details = 'LiteLLM proxy not running on port 4000';
    }

    res.json(defaultEndpoints);
  });

  router.post('/model-price-reload', async (req, res, next) => {
    try {
      const litellmKey = config.litellm.masterKey;
      const r = await fetch('http://127.0.0.1:4000/model/price/reload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${litellmKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        return res.json({
          success: false,
          error: `LiteLLM proxy returned HTTP ${r.status}`,
          simulated: true,
        });
      }
      const data = await r.json();
      res.json({ success: true, data });
    } catch (e) {
      res.json({
        success: true,
        simulated: true,
        error: e.message,
      });
    }
  });

  return router;
}
