import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/omniroute/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'agents/**/*.ts'],
      exclude: ['src/dashboard/**/*.ts'],
      thresholds: {
        lines: 10,
        branches: 10,
        functions: 10,
      },
    },
  },
});
