import { describe, it, expect, vi } from 'vitest';
function createMockReq(body = {}) {
    return { body };
}
function createMockRes() {
    const res = {
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.body = data;
            return this;
        },
    };
    return res;
}
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: (path) => {
            if (globalThis.mockExistsSync)
                return globalThis.mockExistsSync(path);
            return actual.existsSync(path);
        },
        readFileSync: (path, options) => {
            if (globalThis.mockReadFileSync)
                return globalThis.mockReadFileSync(path, options);
            return actual.readFileSync(path, options);
        },
        writeFileSync: (path, content, options) => {
            if (globalThis.mockWriteFileSync) {
                globalThis.mockWriteFileSync(path, content, options);
            }
            else {
                actual.writeFileSync(path, content, options);
            }
        },
    };
});
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        readFile: async (path, options) => {
            if (globalThis.mockReadFile)
                return globalThis.mockReadFile(path, options);
            if (globalThis.mockReadFileSync)
                return globalThis.mockReadFileSync(path, options);
            return actual.readFile(path, options);
        },
        writeFile: async (path, content, options) => {
            if (globalThis.mockWriteFile)
                return globalThis.mockWriteFile(path, content, options);
            if (globalThis.mockWriteFileSync)
                return globalThis.mockWriteFileSync(path, content, options);
            return actual.writeFile(path, content, options);
        },
    };
});
import { createDiscoveryRouter } from '../../src/dashboard/routes/providers/discovery.js';
import { createAliasesRouter } from '../../src/dashboard/routes/providers/aliases.js';
import { resolveUpstreamProvider, getUniqueModels, } from '../../src/dashboard/routes/providers/utils.js';
describe('Providers Router - Model Discovery', () => {
    it('correctly returns model discovery rankings with normalized LMSYS ratings', async () => {
        // Mock the Wulong REST API responses for Arena text and code leaderboards
        const mockTextLeaderboard = {
            meta: { leaderboard: 'text' },
            models: [{ rank: 1, model: 'claude-3-5-sonnet-20240620', vendor: 'Anthropic', score: 1500 }],
        };
        const mockCodeLeaderboard = {
            meta: { leaderboard: 'code' },
            models: [{ rank: 1, model: 'claude-3-5-sonnet-20240620', vendor: 'Anthropic', score: 1600 }],
        };
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockImplementation((url) => {
            // Wulong REST API for Arena leaderboards
            if (url.includes('wulong.dev') && url.includes('name=text')) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTextLeaderboard) });
            }
            if (url.includes('wulong.dev') && url.includes('name=code')) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve(mockCodeLeaderboard) });
            }
            // OpenRouter models API
            if (url.includes('openrouter.ai/api/v1/models')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        data: [
                            {
                                id: 'anthropic/claude-3.5-sonnet',
                                name: 'Claude 3.5 Sonnet',
                                context_length: 200000,
                            },
                        ],
                    }),
                });
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
        const req = createMockReq();
        const res = createMockRes();
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
        // New unified quality score — from Arena ELO normalized
        // text ELO 1500: (1500-1000)/500*100 = 100, code ELO 1600: (1600-1000)/500*100 = 120 → clamped to 100
        // Average = (100 + 100) / 2 = 100
        expect(model.quality_score).toBeDefined();
        expect(model.quality_score).toBe(100);
        expect(model.quality_source).toBe('arena');
        // Context should be resolved from OpenRouter
        expect(model.context).toBe(200000);
        // Restore fetch
        globalThis.fetch = originalFetch;
        delete process.env.OPENROUTER_API_KEY;
    });
    it('correctly resolves upstream provider using prefix matching and keyword fallback', () => {
        expect(resolveUpstreamProvider('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free')).toBe('openrouter');
        expect(resolveUpstreamProvider('opencode/nemotron-3-ultra-free')).toBe('opencode');
        expect(resolveUpstreamProvider('openai/deepseek-ai/deepseek-v4-flash', 'nvidia')).toBe('nvidia');
        expect(resolveUpstreamProvider('openai/big-pickle')).toBe('opencode');
        expect(resolveUpstreamProvider('kilo/some-model')).toBe('kilo');
        expect(resolveUpstreamProvider('nvidia_nim/meta/llama-3.3-70b-instruct')).toBe('nvidia');
    });
    it('correctly normalizes model name prefixes in getUniqueModels', () => {
        const mockCollector = {
            query: () => [
                {
                    model_name: 'openai/deepseek-ai/deepseek-v4-flash',
                    health_status: 'healthy',
                    error_details: null,
                    last_check: null,
                    last_success: null,
                },
            ],
            get: () => null,
        };
        globalThis.mockExistsSync = (path) => true;
        globalThis.mockReadFileSync = (path, options) => `
model_list:
  - model_name: deepseek-ai/deepseek-v4-flash
    litellm_params:
      model: openai/deepseek-ai/deepseek-v4-flash
    model_info:
      provider: nvidia
`;
        try {
            const unique = getUniqueModels(mockCollector);
            const target = unique.find((m) => m.actual_model.includes('deepseek-v4-flash'));
            expect(target).toBeDefined();
            expect(target.provider).toBe('nvidia');
            expect(target.actual_model).toBe('nvidia/deepseek-ai/deepseek-v4-flash');
        }
        finally {
            globalThis.mockExistsSync = undefined;
            globalThis.mockReadFileSync = undefined;
        }
    });
    it('correctly removes compatibility-prefixed models from litellm.yaml and calls delete', async () => {
        const mockYaml = `
model_list:
  - model_name: deepseek-ai/deepseek-v4-flash
    litellm_params:
      model: openai/deepseek-ai/deepseek-v4-flash
    model_info:
      provider: nvidia
`;
        globalThis.mockExistsSync = (path) => true;
        globalThis.mockReadFileSync = (path, options) => mockYaml;
        let writtenContent = '';
        globalThis.mockWriteFileSync = (path, content, options) => {
            writtenContent = content;
        };
        let fetchPayload = null;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockImplementation((url, init) => {
            if (url.includes('/model/delete')) {
                fetchPayload = JSON.parse(String(init.body));
                return Promise.resolve({ ok: true });
            }
            return Promise.resolve({ ok: true });
        });
        const router = createDiscoveryRouter({ collector: null });
        const layer = router.stack.find((l) => l.route?.path === '/model-discovery/remove');
        const handler = layer.route.stack[0].handle;
        const req = createMockReq({ modelId: 'deepseek-ai/deepseek-v4-flash', provider: 'nvidia' });
        const res = createMockRes();
        const next = vi.fn();
        try {
            await handler(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.body.success).toBe(true);
            // Verify yaml write stripped the model
            expect(writtenContent).toContain('model_list: []');
            // Verify fetch /model/delete payload has id, model, and model_name
            expect(fetchPayload).toBeDefined();
            expect(fetchPayload.id).toBe('deepseek-ai/deepseek-v4-flash');
            expect(fetchPayload.model).toBe('openai/deepseek-ai/deepseek-v4-flash');
            expect(fetchPayload.model_name).toBe('deepseek-ai/deepseek-v4-flash');
        }
        finally {
            globalThis.mockExistsSync = undefined;
            globalThis.mockReadFileSync = undefined;
            globalThis.mockWriteFileSync = undefined;
            globalThis.fetch = originalFetch;
        }
    });
    it('correctly normalizes and returns configured models variations on discovery GET', async () => {
        const mockYaml = `
model_list:
  - model_name: Free Models Router
    litellm_params:
      model: openai/openrouter/free
    model_info:
      provider: openrouter
  - model_name: deepseek-ai/deepseek-v4-flash
    litellm_params:
      model: openai/deepseek-ai/deepseek-v4-flash
    model_info:
      provider: nvidia
`;
        globalThis.mockExistsSync = (path) => true;
        globalThis.mockReadFileSync = (path, options) => {
            if (String(path).includes('litellm.yaml'))
                return mockYaml;
            return '[]'; // For other files
        };
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockImplementation((url) => {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
        });
        const router = createDiscoveryRouter({ collector: null });
        const layer = router.stack.find((l) => l.route?.path === '/model-discovery');
        const handler = layer.route.stack[0].handle;
        const req = createMockReq();
        const res = createMockRes();
        const next = vi.fn();
        try {
            await handler(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.body).toBeDefined();
            const conf = res.body.configured_models;
            expect(conf).toBeDefined();
            // Check openrouter/free variations
            expect(conf).toContain('openai/openrouter/free');
            expect(conf).toContain('openrouter/openrouter/free');
            expect(conf).toContain('openrouter/free');
            // Check nvidia/deepseek-v4-flash variations
            expect(conf).toContain('openai/deepseek-ai/deepseek-v4-flash');
            expect(conf).toContain('nvidia/deepseek-ai/deepseek-v4-flash');
            expect(conf).toContain('deepseek-ai/deepseek-v4-flash');
        }
        finally {
            globalThis.mockExistsSync = undefined;
            globalThis.mockReadFileSync = undefined;
            globalThis.fetch = originalFetch;
        }
    });
    it('correctly returns configured models via /model-config while filtering out tier aliases', async () => {
        const mockYaml = `
model_list:
  - model_name: openai/tier-4-planner
    litellm_params:
      model: openai/openrouter/free
  - model_name: openai/tier-4-planner-fb1
    litellm_params:
      model: groq/llama-3.3-70b-versatile
  - model_name: Free Models Router
    litellm_params:
      model: openai/openrouter/free
`;
        globalThis.mockExistsSync = (path) => true;
        globalThis.mockReadFileSync = (path, options) => mockYaml;
        const router = createAliasesRouter();
        const layer = router.stack.find((l) => l.route?.path === '/model-config');
        const handler = layer.route.stack[0].handle;
        const req = createMockReq();
        const res = createMockRes();
        const next = vi.fn();
        try {
            await handler(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.body).toBeDefined();
            expect(Array.isArray(res.body)).toBe(true);
            expect(res.body.length).toBe(1);
            expect(res.body[0].model_name).toBe('Free Models Router');
        }
        finally {
            globalThis.mockExistsSync = undefined;
            globalThis.mockReadFileSync = undefined;
        }
    });
    it('correctly updates fallbacks and preserves/creates primary model entry in litellm.yaml', async () => {
        const mockYaml = `
model_list:
  - model_name: Free Models Router
    litellm_params:
      model: openai/openrouter/free
  - model_name: openai/tier-4-planner-fb1
    litellm_params:
      model: openai/openrouter/free
`;
        globalThis.mockExistsSync = (path) => true;
        globalThis.mockReadFileSync = (path, options) => mockYaml;
        let writtenContent = '';
        globalThis.mockWriteFileSync = (path, content, options) => {
            writtenContent = content;
        };
        const router = createAliasesRouter();
        const layer = router.stack.find((l) => l.route?.path === '/model-aliases' && l.route?.methods?.post);
        const handler = layer.route.stack[0].handle;
        const req = createMockReq({
            tier: 'tier-4-planner',
            fallbacks: ['openai/tier-4-planner-fb1'],
            swapPrimaryWith: -1,
            primaryModel: 'openai/openrouter/free',
        });
        const res = createMockRes();
        const next = vi.fn();
        try {
            await handler(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.body.success).toBe(true);
            // Verify that "Free Models Router" (actual model) was NOT deleted!
            expect(writtenContent).toContain('model_name: Free Models Router');
            // Verify that "openai/tier-4-planner" primary model entry was CREATED!
            expect(writtenContent).toContain('model_name: openai/tier-4-planner');
            expect(writtenContent).toContain('model: openai/openrouter/free');
        }
        finally {
            globalThis.mockExistsSync = undefined;
            globalThis.mockReadFileSync = undefined;
            globalThis.mockWriteFileSync = undefined;
        }
    });
});
