import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.js'],
  },
  {
    // voice-desk browser files: plain ES modules run by the browser, not Bun.
    files: ['voice/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly', navigator: 'readonly', console: 'readonly',
        fetch: 'readonly', WebSocket: 'readonly', Blob: 'readonly', URLSearchParams: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', btoa: 'readonly', atob: 'readonly',
        AudioContext: 'readonly', AudioWorkletNode: 'readonly', AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly', sampleRate: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.ts', 'voice/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Relax some rules for existing codebase
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Good practices
      'no-console': 'off', // We use console for logging
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'always'],
    },
  },
  {
    files: ['src/**/*.test.ts', 'voice/**/*.test.ts'],
    rules: {
      // Relax rules for test files
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  }
);
