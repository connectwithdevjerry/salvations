import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them. This removes
  // a build-orchestration layer and keeps one source of truth per module.
  transpilePackages: [
    '@salvations/core',
    '@salvations/contracts',
    '@salvations/crypto',
    '@salvations/db',
    '@salvations/mcp',
    '@salvations/runtime',
    '@salvations/observability',
    '@salvations/provider-registry',
  ],
  // Required for the container image (AC-16): a self-contained server bundle.
  output: 'standalone',
  // The monorepo root, so standalone tracing follows workspace links correctly.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  // Native/driver packages must stay external to the server bundle rather than
  // being traced and re-bundled. Top-level since Next 15 — it was previously
  // experimental.serverComponentsExternalPackages, which Next now ignores.
  serverExternalPackages: ['mongodb'],
};

export default config;
