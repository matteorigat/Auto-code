import { describe, it, expect, vi } from 'vitest';
import { MetricsCollector } from '../../src/dashboard/collector.mjs';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    existsSync: (path) => {
      if (typeof path === 'string' && path.endsWith('litellm.yaml')) {
        return true;
      }
      return original.existsSync(path);
    },
    readFileSync: (path, options) => {
      if (typeof path === 'string' && path.endsWith('litellm.yaml')) {
        return `
model_list:
  - model_name: openai/tier-4-planner
    litellm_params:
      model: opencode/big-pickle
    model_info:
      provider: opencode
  - model_name: openai/tier-4-planner-fb1
    litellm_params:
      model: opencode/nemotron-3-ultra
    model_info:
      provider: opencode
`;
      }
      return original.readFileSync(path, options);
    },
  };
});

describe('MetricsCollector - OpenCode mapping', () => {
  it('correctly resolves aliases for opencode models', () => {
    const collector = new MetricsCollector();
    // Test for big-pickle, which can be reported as opencode/big-pickle
    const aliases = collector.healthTracker.getAliasesForModel('opencode', 'opencode/big-pickle');
    expect(aliases).toContain('openai/tier-4-planner');

    // Test for other models
    const aliases2 = collector.healthTracker.getAliasesForModel(
      'opencode',
      'opencode/nemotron-3-ultra',
    );
    expect(aliases2).toContain('openai/tier-4-planner-fb1');
  });
});
