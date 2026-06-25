import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.mjs', 'agents/**/*.mjs'],
      exclude: ['src/dashboard/**/*.mjs'],
      thresholds: {
        lines: 10,
        branches: 10,
        functions: 10,
      },
    },
  },
});
