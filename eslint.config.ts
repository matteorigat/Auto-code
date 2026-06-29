import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dashboard/dist/', 'dist/', 'node_modules/', '.git/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      prettier,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        document: 'readonly',
        window: 'readonly',
        sessionStorage: 'readonly',
        queueMicrotask: 'readonly',
        requestAnimationFrame: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        DragEvent: 'readonly',
        DataTransfer: 'readonly',
        Node: 'readonly',
      },
    },
    rules: {
      'prettier/prettier': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettierConfig,
);
