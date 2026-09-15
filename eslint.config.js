import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import local from './tools/eslint-rules/index.js';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { salvations: local },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    // The runtime and the domain core must never branch on a vendor.
    files: ['packages/runtime/**/*.ts', 'packages/core/**/*.ts'],
    rules: { 'salvations/no-provider-branching': 'error' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' } },
  },
  {
    files: ['**/*.test.ts', 'tools/**/*.js'],
    rules: { 'salvations/no-provider-branching': 'off' },
  },
);
