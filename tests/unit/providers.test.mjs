import { describe, it, expect, vi } from 'vitest';
import { createDiscoveryRouter } from '../../src/dashboard/routes/providers/discovery.mjs';

describe('Providers Router - Model Discovery', () => {
  it('correctly returns model discovery rankings with normalized LMSYS ratings', async () => {
    // Mock global fetch to return latest path, text rankings, and code rankings
    const mockLatest = { path: '2026-06-22' };
    const mockText = {
      models: [{ model: 'claude-3-5-sonnet-20240620', score: 1500 }],
    };
    const mockCode = {
      models: [{ model: 'claude-3-5-sonnet-20240620', score: 1600 }],
    };
    const mockCatalog = {
      providers: {
        openrouter: {
          name: 'OpenRouter',
          models: {
            'anthropic/claude-3.5-sonnet': {
              name: 'Claude 3.5 Sonnet',
              cost: { input: 0.0015, output: 0.005 },
            },
          },
        },
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('latest.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockLatest) });
      }
      if (url.includes('text.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockText) });
      }
      if (url.includes('code.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockCode) });
      }
      if (url.includes('catalog.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockCatalog) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    });

    const mockConfig = {
      dashboard: {},
    };

    const router = createDiscoveryRouter({
      collector: null,
    });

    // Find the handler for /model-discovery
    const layer = router.stack.find((l) => l.route?.path === '/model-discovery');
    const handler = layer.route.stack[0].handle;

    const req = {
      body: {},
    };

    const res = {
      status: function (code) {
        this.statusCode = code;
        return this;
      },
      json: function (data) {
        this.body = data;
        return this;
      },
    };

    const next = vi.fn();

    // Set mock env variable so the provider hasKey returns true
    process.env.OPENROUTER_API_KEY = 'test-key';

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.body).toBeDefined();

    const openrouterProv = res.body.providers.find((p) => p.provider === 'openrouter');
    expect(openrouterProv).toBeDefined();

    const model = openrouterProv.models.find((m) => m.id === 'anthropic/claude-3.5-sonnet');
    expect(model).toBeDefined();
    expect(model.benchmarks).toBeDefined();

    // Score 1500 for text maps to: ((1500 - 1000) / 600) * 100 = 83.3
    expect(model.benchmarks.intelligence_index).toBe(83.3);

    // Score 1600 for code maps to: ((1600 - 1000) / 600) * 100 = 100
    expect(model.benchmarks.coding_index).toBe(100);

    // Restore fetch
    globalThis.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
  });
});
