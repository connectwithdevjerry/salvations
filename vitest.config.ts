import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@salvations/core': r('./packages/core/src/index.ts'),
      '@salvations/contracts': r('./packages/contracts/src/index.ts'),
      '@salvations/crypto': r('./packages/crypto/src/index.ts'),
      '@salvations/db': r('./packages/db/src/index.ts'),
      '@salvations/mcp': r('./packages/mcp/src/index.ts'),
      '@salvations/runtime': r('./packages/runtime/src/index.ts'),
      '@salvations/observability': r('./packages/observability/src/index.ts'),
      '@salvations/provider-testkit': r('./packages/providers/testkit/src/index.ts'),
      '@salvations/provider-anthropic': r('./packages/providers/anthropic/src/index.ts'),
      '@salvations/provider-openai': r('./packages/providers/openai/src/index.ts'),
      '@salvations/provider-registry': r('./packages/providers/registry/src/index.ts'),
    },
  },
});
