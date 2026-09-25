# HIVE

An **MCP-native agent host / orchestration platform**. Not a chatbot with integrations.

```
AGENT        replaceable reasoning engine
MCP          the only standardized capability layer
AGENT HOST   context · memory · permissions · execution · orchestration   ← the product
CHANNELS     user interfaces
MCP SERVERS  extensible tools and resources
```

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, execution model, invariants, Phase 1 plan |
| [TODO.md](TODO.md) | Implementation roadmap |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | MongoDB collections, ERD, indexes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel topology and the worker-extraction path |
| [docs/SECURITY.md](docs/SECURITY.md) | AuthN/AuthZ, tenant isolation, MCP threat model |
| [docs/PROVIDER-ABSTRACTION.md](docs/PROVIDER-ABSTRACTION.md) | The `AgentProvider` port |
| [docs/MCP-CLIENT.md](docs/MCP-CLIENT.md) | MCP spec alignment and `ToolGateway` |

## Getting started

```bash
pnpm install
cp .env.example .env.local     # then fill in MONGODB_URI and the secrets
pnpm db:up                     # local MongoDB as a single-node replica set
pnpm verify                    # invariants, boundaries, lint, typecheck, tests
```

A replica set is required even locally: change streams (the run event bus) and
multi-document transactions both depend on one.

## Architectural invariants

These run in CI on every commit. They are not style rules — they are the
architecture expressed as tests.

| # | Invariant |
|---|---|
| I1 | `runtime` / `core` name no integration (Gmail, Telegram, Notion, …) |
| I2 | `runtime` / `core` name no AI provider |
| I3 | `runtime` / `core` / `mcp` / `db` name no deployment platform |
| I4 | the MongoDB driver is imported only inside `packages/db` |
| I5 | the MCP SDK is imported only inside `packages/mcp` |
| I6 | provider SDKs are confined to their own adapter packages |

`pnpm invariants` runs them locally.

## Layout

```
apps/web/          Next.js — UI, API, SSE, run executor. The composition root.
apps/worker/       Phase 4 worker. Compiled and smoke-tested now so the move is config, not discovery.
packages/core/     Pure domain: entities, ports, policy. zod only.
packages/runtime/  Agent runtime. Depends on core ports only.
packages/providers/ Provider adapters + the shared conformance suite.
packages/mcp/      MCP client. The only importer of the MCP SDK.
packages/db/       Data access. The only importer of the MongoDB driver.
```
