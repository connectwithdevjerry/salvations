# Salvations — Implementation Roadmap

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) and the documents in [docs/](./docs).

**Current state:** Phase 0 — architecture revised for MongoDB Atlas + Vercel.
**No application code has been written.** Implementation begins only after final approval.

**Legend:** `[ ]` todo · `[x]` done · **(AC-n)** = acceptance criterion from ARCHITECTURE.md §10.3
· 🔒 = security-critical · ⚓ = load-bearing for a later migration

---

## Phase 0 — Architecture & sign-off

- [x] Inspect repository (greenfield)
- [x] Verify MCP spec `2026-07-28` + official TypeScript SDK **V2** + transports
- [x] Verify MCP authorization direction (OAuth 2.1 RS, RFC 9728/8707/9207, DCR → CIMD)
- [x] Verify MongoDB driver 7.x, Better Auth Mongo adapter, Atlas Vector Search + `$rankFusion`
- [x] Verify Vercel duration limits and `waitUntil` semantics (**it does not outlive `maxDuration`**)
- [x] Revision 2: MongoDB-native data model, Vercel deployment, sliced/resumable execution
- [x] ARCHITECTURE.md · TODO.md · DATA-MODEL.md · DEPLOYMENT.md · SECURITY.md ·
      PROVIDER-ABSTRACTION.md · MCP-CLIENT.md
- [ ] **Final approval** ← *gate: nothing below starts until this is given*
- [ ] ADR-0001…0012 in `docs/adr/` capturing each decision (Mongo over Postgres; no ODM; embedded
      approval; runs-as-queue; sliced executor; three adapters; CIMD; no Redis in Phase 1)

---

## Phase 1 — Vertical slice

### 1.1 Repository foundation

- [x] pnpm workspace + Turborepo; Node 22 pinned
- [x] `tsconfig.base.json` — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- [x] Package skeletons per ARCHITECTURE.md §6
- [x] 🔒 `.dependency-cruiser.cjs` — invariants **I4, I5, I6**
- [x] 🔒 ESLint rule `no-provider-branching` in `tools/eslint-rules`
- [x] 🔒 CI grep gates — **(AC-11) (AC-12) (AC-13)**
- [x] `docker-compose.yml` — local single-node **replica set** (`--replSet rs0`; change streams and
      transactions require one)
- [x] `.env.example` + secret-scanning pre-commit hook
- [x] CI: typecheck · lint · boundaries · grep gates · unit · integration · Docker build
- [ ] Vitest + `mongodb-memory-server` (replica-set mode) or a disposable Atlas test database

### 1.2 Data layer — MongoDB ⚓

- [x] `MongoClient` singleton cached on `globalThis`, `monitorCommands: true`, tuned `maxPoolSize`
- [x] 🔒 `ScopedDb` / `ScopedCollection` — filter merge, insert stamping, pipeline `$match` prefix,
      `$lookup`/`$unionWith` sub-pipeline enforcement, audited `unsafeUnscoped()` escape hatch
- [x] 🔒 **Command-monitoring tenancy guard** — throws in dev/test/CI, alerts in prod; small
      reviewed allowlist (Better Auth globals, `runs` claim index, platform catalog)
- [ ] Collection definitions + `$jsonSchema` validators generated from Zod
- [x] All indexes from `DATA-MODEL.md` §8; idempotent index-sync migration runner
- [x] Mappers (`toDomain` / `toDocument`); UUIDv7 ID generation
- [ ] Repositories: workspaces, apiKeys, agents, agentVersions, providerConfigs, modelBindings,
      credentials, oauthConnections, mcpServers, mcpServerBindings, mcpCapabilities, policies,
      conversations, messages, runs, runSteps, runEvents, approvals, channels, auditLog, usageDaily
- [ ] Seed script (demo workspace, agent, provider configs)
- [x] 🔒 **(AC-10)** Adversarial tenant-isolation suite — every repository method, wrong workspace
- [ ] Atlas setup: separate `app` / `migrate` users; `app` has no update/delete on `auditLog`

### 1.3 Crypto & secrets

- [ ] `KeyProvider` port; `LocalFileKeyProvider` (dev) + `EnvKeyProvider` (Vercel);
      `KmsKeyProvider` / `VaultKeyProvider` interfaces stubbed
- [ ] 🔒 Envelope encryption (AES-256-GCM, per-credential DEK, workspace KEK, `kekVersion`)
- [ ] `CredentialResolver` — short-lived, non-serialisable handles
- [ ] 🔒 Redaction: schema-driven + entropy heuristic; applied at write time
- [ ] 🔒 **(AC-17)** Redaction corpus test across runs / steps / events / audit / logs
- [ ] Online KEK rotation path

### 1.4 Auth & authorization 🔒

- [ ] Better Auth + `@better-auth/mongo-adapter`: email/password (Argon2id), one OAuth provider,
      TOTP 2FA, email verification, rate limiting
- [ ] Session hardening: httpOnly/SameSite/Secure, rotation, global revocation on credential change
- [ ] Workspaces: create, invite (hashed tokens), accept, membership, role changes — all via
      targeted `$push`/`$pull`/arrayFilter updates, never whole-array rewrites
- [ ] API keys: `sk_<env>_<prefix>_<secret>`, SHA-256 storage, constant-time compare
- [ ] `Principal` resolution middleware + `WorkspaceScope` derivation
- [ ] 🔒 RBAC permission sets + **server-side** route guards (UI hiding is never enforcement)
- [ ] 🔒 `PermissionBroker` — full evaluation order, deny-wins, annotations-as-floor, fail-closed
- [ ] 🔒 Delegation: `effective(agent) = agentVersion ∩ onBehalfOf ∩ workspacePolicy`, snapshotted
      into `run.principal`, **re-validated on resume**
- [ ] 🔒 HMAC auth for `/api/internal/*` — unreachable with a session cookie
- [ ] **(AC-1)** end-to-end signup → workspace → invite → shared agent

### 1.5 Provider abstraction ⚓

- [ ] `packages/core/src/ports/agent-provider.ts` — port, `ModelCapabilities`,
      `GenerationRequest`, `ProviderEvent`, canonical `ContentBlock`
- [ ] Canonical message serialisation + `providerArtifacts` sidecar semantics
- [ ] **`packages/providers/testkit` — conformance suite written BEFORE the first adapter**
- [ ] Anthropic adapter — adaptive thinking + effort, explicit cache breakpoints, no prefill,
      artifact replay rules
- [ ] OpenAI adapter
- [ ] Google adapter
- [ ] Provider registry; capabilities cache + TTL refresh onto `modelBindings`
- [ ] Cost computation → `run.usage` + `usageDaily` `$inc` upsert
- [ ] 🔒 **(AC-14)** all three adapters pass the identical suite
- [ ] 🔒 **(AC-6)** cross-provider continuation: verbatim replay same-model, drop cross-model

### 1.6 MCP client ⚓

- [ ] `@modelcontextprotocol/client@2` + Streamable HTTP transport
- [ ] `versionNegotiation: 'auto'`; persist `negotiatedProtocolVersion` per binding
- [ ] `McpServerRegistry`, `McpConnectionFactory`, typed `ConnectionScopeKey`
- [ ] `McpClientManager` — concurrency semaphore, circuit breaker, health tracking
- [ ] 🔒 `McpOAuthClient` — RFC 9728 discovery, PKCE, **CIMD `client_id`** + hosted
      `/.well-known/mcp-client-metadata.json`, **RFC 8707 resource indicator**,
      **RFC 9207 issuer validation**, DCR fallback, refresh + revocation
- [ ] `CapabilityDiscovery` — `server/discover` → `tools/list`, honouring `ttlMs`
- [ ] 🔒 `cacheScope` handling — workspace vs user cache keys; **fail closed when absent**
- [ ] `CapabilityStore` — normalise, `definitionHash`, diff, soft-delete
- [x] 🔒 **(AC-7)** atomic approval invalidation in the same write as the hash update + diff UI
- [ ] `ToolGateway` — resolve → permit → Ajv 2020-12 validate → invoke → normalise → audit;
      denial returned as an `is_error` tool result
- [ ] Canonical namespacing `alias__tool`; provider-legal transform with hash suffix + reverse map
- [ ] 🔒 **(AC-15)** MRTR — human path suspends; **inference path denied by default**;
      `requestState` echoed verbatim, never parsed or logged in full
- [ ] Result size capping + blob spill
- [ ] Per-tool-call timeout **shorter than `RESERVE_MS`**
- [ ] 🔒 Test: two users on a `perUserAuth` binding never share a discovery cache entry
- [ ] **(AC-3)** real third-party server installed end-to-end

### 1.7 Agent Runtime ⚓

- [ ] `RunBudget` + `BudgetMeter` (steps, tool calls, tokens, wall clock, cost, MRTR rounds)
- [ ] `Resolver` — pin `agentSnapshot`, model binding, principal, budget into the run
- [ ] `ContextAssembler` — fixed cache-stable ordering; no timestamps or unsorted maps in the prefix
- [ ] 🔒 **(I9)** prefix-stability CI test
- [ ] `CapabilitySelector` — pre-filter denied capabilities before the model sees them
- [ ] `ModelCall` — streaming → `runEvents`, retry with jitter, `fallbackBindingId`
- [ ] `ToolPhase` — parallel calls, **all results in one tool message**
- [ ] **`AgentRuntime.stepOnce()`** — the environment-agnostic unit ⚓
- [ ] Suspension states (`waiting_approval`, `waiting_input`, `waiting_tool`) + resumption
- [ ] Compaction at threshold → summary message + `compaction` step (never silent truncation)
- [ ] Loop detection on repeated identical tool calls; per-agent + per-workspace kill switch
- [ ] 🔒 **(AC-8)** budget exhaustion → clean partial result + accurate cost

### 1.8 Execution & queue ⚓

- [x] `RunQueue` port + `MongoRunQueue` — atomic lease claim, heartbeat, release
- [x] 🔒 **Every run write guarded by `lease.token`** (prevents stolen-lease double writes)
- [ ] `Deadline` + `RunExecutor` ports
- [ ] `SlicedExecutor` — loop to deadline − `RESERVE_MS`, persist, release, re-queue, continue
- [ ] `BackgroundTrigger` port + Vercel implementation (`waitUntil` + HMAC self-call) — **the only
      Vercel-aware adapter**
- [ ] `/api/internal/execute` (maxDuration 800) and `/api/internal/sweep` (stalled-lease reclaim)
- [ ] `attempts` cap → clean failure with partial result
- [ ] 🔒 **(AC-9)** kill executor mid-run **and** force a lease steal → completes once, no duplicate
      side effects
- [ ] Metrics: slice-yield rate, sweeper reclaims, cold starts, Mongo connection churn

### 1.9 API, streaming & web

- [ ] `packages/contracts` — Zod contracts shared by API and UI
- [ ] API routes: auth, workspaces, members, apiKeys, providerConfigs, modelBindings, agents,
      mcpServers, mcpBindings, capabilities, approvals, policies, conversations, runs, credentials,
      health
- [ ] `RunEventBus` port + `ChangeStreamEventBus` (+ `PollingEventBus` fallback, capability-probed)
- [ ] `/api/runs/:id/events` — SSE with `after=<seq>` cursor replay ⚓
- [ ] Web UI: auth pages, workspace switcher, agent editor, chat with token streaming, run timeline
      (steps · tool calls · usage · cost), MCP install + OAuth flow, **capability approval with
      definition diffs**, policy editor, approval modal, provider/model binding management
- [ ] **(AC-2) (AC-4) (AC-5)** exercised through the UI

### 1.10 Observability & containers

- [ ] OTel traces `run → step → model_call | tool_call`; OTLP export
- [ ] Structured logging + 🔒 redaction middleware
- [ ] `auditLog` writer wired to broker, gateway, credential resolution, admin actions
- [ ] `usageDaily` rollups; cache-hit-rate alert
- [ ] `/api/health` + `/api/health/ready`
- [ ] ⚓ **(AC-16)** `apps/web` Dockerfile built **and booted** in CI against a test database
- [x] ⚓ `apps/worker` placeholder: Dockerfile + entrypoint that claims and runs one run via
      `ContinuousExecutor` — *not deployed*, but compiled and smoke-tested so Phase 4 is a
      configuration change rather than a discovery exercise

### 1.11 Phase 1 exit

- [ ] All 17 acceptance criteria green; the 11 starred ones in CI
- [ ] Threat-model review against `SECURITY.md` §7 recorded in `docs/adr/`
- [ ] Runbooks: credential rotation · stuck run · MCP server outage · cost spike ·
      Mongo connection exhaustion

---

## Phase 2 — Documents, memory & RAG (Atlas Vector Search)

- [ ] `VectorStore` / `MemoryStore` / `DocumentStore` ports
- [ ] `collections`, `documents`, `documentChunks` with model-keyed `embeddings` sub-document
- [ ] Atlas **Vector Search** indexes per embedding path (`numDimensions`, `similarity`)
- [ ] 🔒 **`workspaceId` as a `filter` field inside every vector index** — a `$vectorSearch` is not
      constrained by a later `$match` (`SECURITY.md` R15)
- [ ] Atlas Search (lexical) index on chunk content
- [ ] **`$rankFusion`** hybrid retrieval — native, server-side RRF (requires MongoDB 8.1+)
- [ ] Resumable ingestion pipeline: fetch → extract → chunk → embed → index, per-stage checkpoints
- [ ] Extractors: PDF, DOCX, HTML, Markdown, plain text
- [ ] Embedding model bindings (`role: 'embedding'`) through the same provider abstraction
- [ ] Bitemporal `memoryEntries` (supersede, never update) + `memory_write` run steps
- [ ] Ingest from MCP resources (`sourceType: 'mcp_resource'`)
- [ ] Re-embedding as an additive field write + new index (no collection rebuild)
- [ ] 🔒 Document ACLs enforced inside the search stage

## Phase 3 — MCP breadth

- [ ] MCP **resources** + `resources/read` as context (not tools)
- [ ] MCP **prompts** as agent-selectable templates
- [ ] `subscriptions/listen` opt-in → live `list_changed` invalidation
- [ ] **Tasks extension** (`tasks/get` / `tasks/update` / `tasks/cancel`) → `waiting_tool`
- [ ] 🔒 **stdio transport, sandboxed** — container, read-only rootfs, no ambient credentials,
      egress allowlist, CPU/memory/PID caps; first-party + verified tiers only
- [ ] Platform MCP catalog (`workspaceId: null`) + one-click install
- [ ] `trustTier`-driven approval defaults; scoped remembered decisions (R14)

## Phase 4 — Separate worker service ⚓

*This phase should be small. If it is not, the Phase 1 seams were wrong.*

- [ ] Promote `apps/worker` to a real service: `ContinuousExecutor` + long-lived Mongo connection
- [ ] `RedisRunQueue` (BullMQ) as a **notification** layer — MongoDB stays the source of truth
- [ ] `RedisEventBus` alongside the change-stream bus
- [ ] Per-workspace rate limits and queue groups (noisy-neighbour control)
- [ ] Deploy to ECS/Fargate (or any container host) against the same Atlas cluster
- [ ] Vercel keeps serving UI, API and SSE — **frontend unchanged**
- [ ] 🔒 Verify: no change required in `packages/core`, `packages/runtime`, or `packages/mcp`
- [ ] Then: user-facing **scheduling** (`schedules` collection, cron UI, overlap policy) and
      sub-agent orchestration, both of which want a long-lived executor

## Phase 5 — Channels & first-party MCP servers

- [ ] Telegram `ChannelAdapter`: webhook + secret verification 🔒, throttled edits, inline-keyboard
      approvals
- [ ] 🔒 `channelIdentities` linking flow; unlinked identities are minimal-privilege
- [ ] Channel capability degradation matrix + tests
- [ ] First-party MCP servers (`@modelcontextprotocol/server`): memory, documents, workspace-admin,
      orchestration
- [ ] In-process transport — same client interface, same `ToolGateway`
- [ ] 🔒 Verify no runtime back doors were added for our own servers

## Phase 6 — Platform hardening & scale

- [ ] `KmsKeyProvider` / `VaultKeyProvider`; evaluate MongoDB **Queryable Encryption** for credentials
- [ ] Public API + SDK; per-key rate limits and quotas
- [ ] Billing: metering, plan limits, per-workspace cost caps
- [ ] 🔒 Deep prompt-injection defence (R1): untrusted-data framing, trust-tier chaining rules,
      expanded adversarial corpus
- [ ] 🔒 Cross-binding data-flow policy (confused-deputy, `SECURITY.md` §6.5)
- [ ] Atlas: read preferences, sharding evaluation, archival of `runEvents` / `auditLog`
- [ ] Data export + workspace deletion (cascading through blob storage)
- [ ] SOC 2 evidence: audit completeness, access reviews, key-rotation records
- [ ] Load testing: 100 concurrent runs, 50 MCP bindings
- [ ] MCP spec-upgrade drill — confirm a protocol bump touches only `packages/mcp`

---

## Standing invariants (CI, every commit)

| # | Invariant |
|---|---|
| I1 | No integration names in `packages/runtime` / `packages/core` |
| I2 | No provider names in `packages/runtime` / `packages/core` |
| I3 | No platform names (`vercel`, `@vercel`) in `runtime` / `core` / `mcp` / `db` |
| I4 | `mongodb` imported only inside `packages/db` |
| I5 | `packages/core` imports nothing but `zod` |
| I6 | `packages/runtime` never imports providers, MCP concretes, or `db` |
| I7 | Every provider adapter passes the conformance suite |
| I8 | No unscoped tenant query (command-monitoring guard throws) |
| I9 | Prompt prefix is byte-stable across identical state |
| I10 | No secret reachable from run / step / event / audit / log |
