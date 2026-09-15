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
  experimental: {
    // The MongoDB driver and provider SDKs must stay external to the server bundle.
    serverComponentsExternalPackages: ['mongodb'],
  },
};

export default config;
