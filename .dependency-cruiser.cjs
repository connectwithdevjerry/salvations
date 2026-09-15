/**
 * Package boundaries (ARCHITECTURE.md §3.1).
 *
 *   core  <-  runtime  <-  apps
 *     ^          ^
 *     +-- mcp, providers, db, crypto, contracts, observability
 *
 * Architecture that is not enforced is a wish.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      severity: 'error',
      comment:
        'packages/core holds entities, ports and pure policy. It may depend on zod and nothing ' +
        'else — no driver, no HTTP, no SDK. A dependency here is a leak into the domain.',
      from: { path: '^packages/core/', pathNot: '\\.test\\.ts$' },
      to: {
        pathNot: ['^packages/core/', '^node_modules/zod/', 'node_modules/typescript'],
        dependencyTypesNot: ['type-only', 'core'],
      },
    },
    {
      name: 'runtime-depends-on-ports-only',
      severity: 'error',
      comment:
        'packages/runtime receives implementations by injection. Importing a concrete adapter ' +
        'binds the runtime to a vendor, a database, or a deployment platform.',
      from: { path: '^packages/runtime/', pathNot: '\\.test\\.ts$' },
      to: { path: '^packages/(db|mcp|providers|channels|crypto|observability)/' },
    },
    {
      name: 'runtime-is-platform-agnostic',
      severity: 'error',
      comment: 'Vercel APIs belong behind the BackgroundTrigger port, in the composition root only.',
      from: { path: '^packages/(runtime|core|mcp|db)/' },
      to: { path: 'node_modules/@vercel/' },
    },
    {
      name: 'mongodb-only-in-db',
      severity: 'error',
      comment:
        'The driver is reachable only through ScopedDb, which is what makes the tenancy guard ' +
        'unavoidable. See docs/DATA-MODEL.md §0.3.',
      from: { pathNot: '^packages/db/' },
      to: { path: 'node_modules/mongodb/' },
    },
    {
      name: 'mcp-sdk-only-in-mcp',
      severity: 'error',
      comment: 'All protocol contact is confined to packages/mcp so a spec bump is one package.',
      from: { pathNot: '^packages/mcp/' },
      to: { path: 'node_modules/@modelcontextprotocol/' },
    },
    {
      name: 'provider-sdks-only-in-adapters',
      severity: 'error',
      from: { pathNot: '^packages/providers/(anthropic|openai|google)/' },
      to: { path: 'node_modules/(@anthropic-ai/sdk|openai|@google/genai)/' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Next.js app-router files are framework entrypoints, not imports — exempt.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$', 'index\\.ts$', '(^|/)tsconfig',
          '^apps/web/src/app/.*\\.tsx?$', '^apps/[^/]+/src/main\\.ts$',
          '(^|/)next\\.config\\.ts$', '(^|/)next-env\\.d\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Build output is generated, not authored — cruising it reports noise.
    exclude: { path: '(^|/)(\\.next|\\.turbo|dist|coverage)/' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'default'] },
  },
};
