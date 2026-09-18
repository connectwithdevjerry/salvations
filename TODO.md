# HIVE — Implementation Roadmap

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) and the documents in [docs/](./docs).

**Current state:** Phase 1 complete through §1.10, plus the Phase 2 product scope below.
The catalogue direction — named, hard-coded integrations rather than a generic MCP URL box —
was set after Phase 1 and supersedes the "no integrations in Phase 1" line that was here.

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
- [x] Collection definitions + `$jsonSchema` validators generated from Zod
- [x] All indexes from `DATA-MODEL.md` §8; idempotent index-sync migration runner
- [x] Mappers (`toDomain` / `toDocument`); UUIDv7 ID generation
- [x] Repositories: workspaces, apiKeys, agents, agentVersions, providerConfigs, modelBindings,
      credentials, oauthConnections, mcpServers, mcpServerBindings, mcpCapabilities, policies,
      conversations, messages, runs, runSteps, runEvents, approvals, channels, auditLog, usageDaily
- [x] Seed script (demo workspace, agent, provider configs)
- [x] 🔒 **(AC-10)** Adversarial tenant-isolation suite — every repository method, wrong workspace
- [x] Atlas setup: separate `app` / `migrate` users; `app` has no update/delete on `auditLog`

### 1.3 Crypto & secrets

- [x] `KeyProvider` port; `LocalFileKeyProvider` (dev) + `EnvKeyProvider` (Vercel);
      `KmsKeyProvider` / `VaultKeyProvider` interfaces stubbed
- [x] 🔒 Envelope encryption (AES-256-GCM, per-credential DEK, workspace KEK, `kekVersion`)
- [x] `CredentialResolver` — short-lived, non-serialisable handles
- [x] 🔒 Redaction: schema-driven + entropy heuristic; applied at write time
- [x] 🔒 **(AC-17)** Redaction corpus test across runs / steps / events / audit / logs
- [x] Online KEK rotation path

### 1.4 Auth & authorization 🔒

- [x] Better Auth + `@better-auth/mongo-adapter`: email/password (Argon2id), one OAuth provider,
      TOTP 2FA, email verification, rate limiting
- [x] Session hardening: httpOnly/SameSite/Secure, rotation, global revocation on credential change
- [x] Workspaces: create, invite (hashed tokens), accept, membership, role changes — all via
      targeted `$push`/`$pull`/arrayFilter updates, never whole-array rewrites
- [x] API keys: `sk_<env>_<prefix>_<secret>`, SHA-256 storage, constant-time compare
- [x] `Principal` resolution middleware + `WorkspaceScope` derivation
- [x] 🔒 RBAC permission sets + **server-side** route guards (UI hiding is never enforcement)
- [x] 🔒 `PermissionBroker` — full evaluation order, deny-wins, annotations-as-floor, fail-closed
- [x] 🔒 Delegation: `effective(agent) = agentVersion ∩ onBehalfOf ∩ workspacePolicy`, snapshotted
      into `run.principal`, **re-validated on resume**
- [x] 🔒 HMAC auth for `/api/internal/*` — unreachable with a session cookie
- [ ] **(AC-1)** end-to-end signup → workspace → invite → shared agent

### 1.5 Provider abstraction ⚓

- [x] `packages/core/src/ports/agent-provider.ts` — port, `ModelCapabilities`,
      `GenerationRequest`, `ProviderEvent`, canonical `ContentBlock`
- [x] Canonical message serialisation + `providerArtifacts` sidecar semantics
- [x] **`packages/providers/testkit` — conformance suite written BEFORE the first adapter**
- [x] Anthropic adapter — adaptive thinking + effort, explicit cache breakpoints, no prefill,
      artifact replay rules
- [x] OpenAI adapter
- [x] Google adapter
- [x] Provider registry; capabilities cache + TTL refresh onto `modelBindings`
- [x] Cost computation → `run.usage` + `usageDaily` `$inc` upsert
- [x] 🔒 **(AC-14)** all three adapters pass the identical suite
- [x] 🔒 **(AC-6)** cross-provider continuation: verbatim replay same-model, drop cross-model

### 1.6 MCP client ⚓

- [x] `@modelcontextprotocol/client@2` + Streamable HTTP transport
- [x] `versionNegotiation: 'auto'`; persist `negotiatedProtocolVersion` per binding
- [x] `McpServerRegistry`, `McpConnectionFactory`, typed `ConnectionScopeKey`
- [x] `McpClientManager` — concurrency semaphore, circuit breaker, health tracking
- [x] 🔒 `McpOAuthClient` — RFC 9728 discovery, PKCE, **CIMD `client_id`** + hosted
      `/.well-known/mcp-client-metadata.json`, **RFC 8707 resource indicator**,
      **RFC 9207 issuer validation**, DCR fallback, refresh + revocation
- [x] `CapabilityDiscovery` — `server/discover` → `tools/list`, honouring `ttlMs`
- [x] 🔒 `cacheScope` handling — workspace vs user cache keys; **fail closed when absent**
- [x] `CapabilityStore` — normalise, `definitionHash`, diff, soft-delete
- [x] 🔒 **(AC-7)** atomic approval invalidation in the same write as the hash update + diff UI
- [x] `ToolGateway` — resolve → permit → Ajv 2020-12 validate → invoke → normalise → audit;
      denial returned as an `is_error` tool result
- [x] Canonical namespacing `alias__tool`; provider-legal transform with hash suffix + reverse map
- [x] 🔒 **(AC-15)** MRTR — human path suspends; **inference path denied by default**;
      `requestState` echoed verbatim, never parsed or logged in full
- [x] Result size capping + blob spill
- [x] Per-tool-call timeout **shorter than `RESERVE_MS`** — 30s default against a 45s reserve
- [x] 🔒 Test: two users on a `perUserAuth` binding never share a discovery cache entry
- [ ] **(AC-3)** real third-party server installed end-to-end — needs a live server and real
      OAuth consent, so it is a **manual verification**, not something CI can assert

### 1.7 Agent Runtime ⚓

- [x] `RunBudget` + `BudgetMeter` (steps, tool calls, tokens, wall clock, cost, MRTR rounds)
- [x] `Resolver` — pin `agentSnapshot`, model binding, principal, budget into the run
- [x] `ContextAssembler` — fixed cache-stable ordering; no timestamps or unsorted maps in the prefix
- [x] 🔒 **(I9)** prefix-stability CI test
- [x] `CapabilitySelector` — pre-filter denied capabilities before the model sees them
- [x] `ModelCall` — streaming → `runEvents`, retry with jitter, `fallbackBindingId`
- [x] `ToolPhase` — parallel calls, **all results in one tool message**
- [x] **`AgentRuntime.stepOnce()`** — the environment-agnostic unit ⚓
- [x] Suspension states (`waiting_approval`, `waiting_input`, `waiting_tool`) + resumption
- [x] Compaction at threshold → summary message + `compaction` step (never silent truncation)
- [x] Loop detection on repeated identical tool calls; per-agent + per-workspace kill switch
- [x] 🔒 **(AC-8)** budget exhaustion → clean partial result + accurate cost

### 1.8 Execution & queue ⚓

- [x] `RunQueue` port + `MongoRunQueue` — atomic lease claim, heartbeat, release
- [x] 🔒 **Every run write guarded by `lease.token`** (prevents stolen-lease double writes)
- [x] `Deadline` + `RunExecutor` ports
- [x] `SlicedExecutor` — loop to deadline − `RESERVE_MS`, persist, release, re-queue, continue
- [x] `BackgroundTrigger` port + Vercel implementation (`waitUntil` + HMAC self-call) — **the only
      Vercel-aware adapter**
- [x] `/api/internal/execute` (maxDuration 300) and `/api/internal/sweep` (stalled-lease reclaim
      + re-trigger of orphaned `queued` runs)
- [x] `attempts` cap → clean failure with partial result
- [x] 🔒 **(AC-9)** kill executor mid-run **and** force a lease steal → completes once, no duplicate
      side effects
- [x] Metrics: slice-yield rate, sweeper reclaims, lease losses, step durations
- [ ] Bind the executor in `/api/internal/execute` — needs the composition root, which lands
      with §1.9

### 1.9 API, streaming & web

- [x] `packages/contracts` — Zod contracts shared by API and UI
- [x] API routes: auth, workspaces, apiKeys*, providerConfigs, modelBindings, agents,
      mcpServers, mcpBindings, capabilities, approvals, conversations, runs, credentials*,
      health  *(\*apiKeys, credentials and policies routes remain — §1.9 tail)*
- [x] `RunEventBus` port + `ChangeStreamEventBus` (+ `PollingEventBus` fallback, capability-probed)
- [x] `/api/workspaces/:id/runs/:id/events` — SSE with `after=<seq>` cursor replay ⚓
- [x] Web UI: auth pages, workspace switcher, agent editor, chat with token streaming, run timeline
      (steps · tool calls · usage · cost), MCP install, **capability approval with definition
      diffs**, approval modal, provider/model binding management
- [ ] Policy editor UI + `/policies` routes
- [ ] MCP OAuth consent flow wired end to end (the client exists; the callback route does not)
- [ ] **(AC-2) (AC-4) (AC-5)** exercised through the UI — needs a live database and real keys

### 1.10 Observability & containers

- [x] OTel traces `run → step → model_call | tool_call`; OTLP export
      *(OTLP/HTTP JSON written directly — the wire format, not the SDK; see
      `packages/observability/src/tracing.ts` for the trade and the seam)*
- [x] Structured logging + 🔒 redaction middleware
- [x] `auditLog` writer wired to the gateway (tool calls, refusals, approvals)
- [ ] `auditLog` for credential resolution and admin actions — routes still unwired
- [x] `usageDaily` rollups; cache-hit-rate alert
- [x] `/api/health` + `/api/health/ready`
- [x] ⚓ **(AC-16)** `apps/web` Dockerfile built **and booted** in CI against a test database
- [x] ⚓ `apps/worker` placeholder: Dockerfile + entrypoint that claims and runs one run via
      `ContinuousExecutor` — *not deployed*, but compiled and smoke-tested so Phase 4 is a
      configuration change rather than a discovery exercise
- [ ] Tracer wired into the executor — the tracer exists and is tested; nothing emits spans yet

### 1.11 Phase 1 exit

- [ ] All 17 acceptance criteria green; the 11 starred ones in CI
- [ ] Threat-model review against `SECURITY.md` §7 recorded in `docs/adr/`
- [ ] Runbooks: credential rotation · stuck run · MCP server outage · cost spike ·
      Mongo connection exhaustion

---

## Phase 1.5 — The product (catalogue direction)

Integrations are a **named, hard-coded catalogue**, not a generic "paste an MCP URL" box. The
vendor code lives in `packages/catalog`, `packages/channels` and the adapters; the agent's step
loop still knows nothing about any of it, which is what keeps I1–I3 true and lets a fourth
platform exist beside the first three.

### 1.5.1 Channels — done

- [x] `packages/catalog` — CHANNELS and INTEGRATIONS with setup steps, granted scopes, brand colour
- [x] `packages/channels` — `ChannelAdapter` port + Telegram, Discord, Slack
- [x] 🔒 Per-platform delivery authentication: echoed secret, HMAC-SHA256, Ed25519
- [x] 🔒 Replay windows — a valid signature over a stale body is rejected
- [x] 🔒 Ownership handshake — a bot token proves nothing about who pasted it
- [x] 🔒 Delivery de-duplication on a unique index; the claim is released if the work fails
- [x] `channels` / `channelIdentities` / `channelEvents` + `ChannelRepository`
- [x] Inbound webhook → conversation → run; outbound delivery on run completion
- [x] Integrations page rendered from the catalogue

### 1.5.2 Schedule — done

- [x] `packages/schedule` — five-field cron, DST-correct via Intl, dom/dow OR rule
- [x] `schedules` collection + conditional-update occurrence claiming
- [x] Tick on the existing sweeper; capped catch-up; self-disabling after repeated failures
- [x] Schedule page with presets and a visible expression

### 1.5.3 Billing — done, unconfigured by default

- [x] `packages/catalog/plans` — the plan, hard-coded
- [x] `packages/billing` — `PaymentProcessor` port + Stripe over its REST API
- [x] 🔒 Webhook signature + replay window; all-or-none env configuration
- [x] Entitlements that fail OPEN when no processor is configured
- [x] Checkout page; card details never reach this codebase
- [ ] Decide what a limit actually does when reached — currently nothing enforces `limits`
- [ ] Customer portal link for changing the card on file

### 1.5.4 Knowledge, memory and the agent's server — done

- [x] `packages/knowledge` — text extraction (text, Markdown, HTML, CSV, JSON; PDF/Word refused
      with the fix in the message), paragraph-first chunking with overlap, two-signal ranking
- [x] `knowledgeDocuments` / `knowledgeChunks` — workspace-scoped, compound text index for
      lexical candidates, bounded vector scan for semantic ones, unique-per-content
- [x] First-party `knowledge` server: `search`, `documents`, `read` — read-only by construction
- [x] Knowledge page: upload or type in, "try a question" runs the agents' own search
- [x] Per-agent memory (`memoryEntries`, first-party `memory` server) — bitemporal, one current
      belief per key enforced by the database
- [x] An agent attached to nothing reaches EVERYTHING the workspace connects (expanded onto the
      run's snapshot, so it stays auditable); a narrowed list is the deliberate exception
- [x] Create-agent wizard from the Agents page: name → Telegram (QR to BotFather for people
      without a bot; QR + deep link for the handshake) → own Claude/OpenAI key → the agent's
      server coming together, every line a real check
- [x] Speak tab: record in the browser, transcript shown before the answer, reply read aloud by the
      browser's own voice; spoken turns live in a "Spoken" conversation per assistant
- [x] Documents keep the original text and hand it back as a file — there is no separate Files
      store, because a file the assistant should know IS knowledge; a Files tab returns when
      assistants produce files of their own
- [x] OpenAI transcription and embedding models in the catalogue, bound on connect; the adapter
      embeds, so memory and knowledge search by meaning once OpenAI is connected
- [ ] PDF and Word ingestion — needs a parser that is its own project; refused honestly for now
- [ ] Atlas `$vectorSearch` once a workspace outgrows the in-process candidate caps

### 1.5.5 Integrations over OAuth — done

- [x] 🔒 `oauthConnections` credential store: token sets and PKCE verifiers envelope-encrypted like
      API keys; one row per connection scope; the callback finds a pending consent by its state
- [x] `/api/mcp/callback` + per-binding `authorize` route; the callback cookie names the
      connection, the state check proves the response belongs to it
- [x] A server wanting consent surfaces as `AuthorizationRequiredError` with the URL, never as
      "down"; runs present the stored token per scope
- [x] Catalogue integrations (GitHub, Notion, Linear) carry the vendor's MCP URL; one Connect
      button; `verified` tier; every tool available to every agent on return
- [x] Integrations are peculiar to each assistant: bindings carry the assistant, aliases are
      unique per assistant, a run sees only its own assistant's connections (plus first-party),
      and the Integrations tab lives on the assistant. The old workspace-wide `ws_alias` index
      is retired by the sync
- [ ] Vendor MCP URLs were written from memory — the docs hosts are blocked from this session.
      Verify `api.githubcopilot.com/mcp/`, `mcp.notion.com/mcp`, `mcp.linear.app/mcp` against each
      vendor's page before relying on them
- [ ] Google Workspace: needs its own adapter (Gmail/Calendar/Drive over REST with our OAuth).
      Shown as coming soon rather than as a button that cannot complete
- [ ] Disconnecting an integration (no delete route yet) and token refresh on expiry sweep

### 1.5.6 Every assistant is an MCP server — done

- [x] `/mcp/w/{workspace}/assistants/{assistant}` — created with the assistant, served stateless
      over streamable HTTP through `packages/servers`, authenticated with our own keys
- [x] One surface: `ask` (a real run — model, memory, knowledge, every integration, approvals
      included), `describe`, `recall`, `remember`, `search_knowledge`, `conversations`
- [x] `assistantSurface()` is the single definition of what an assistant can do; runs, the
      `capabilities` tool and the server all read it
- [x] API keys can finally be minted, listed and revoked; scopes are capped at the minter's own
- [x] Server tab: URL, what it unites, keys shown once, client config
- [ ] Re-export integration tools raw on the assistant's server — needs somewhere for an
      approval to wait outside a run; `ask` is the honest route until then
- [ ] OAuth on the assistant's server, for clients that cannot send a bearer header

### 1.5.7 Still to decide or build

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

## Phase 5 — Channel depth & first-party MCP servers

*The channels themselves shipped in Phase 1.5. What is left here is depth.*

- [x] Telegram `ChannelAdapter`: webhook + secret verification 🔒
- [x] 🔒 Unlinked identities are minimal-privilege (`trust: 'unlinked'` on the run's principal)
- [ ] Throttled edits and inline-keyboard approvals — deciding an approval from the chat itself,
      rather than being sent to the web app for it
- [ ] 🔒 `channelIdentities` LINKING flow — tying a platform account to a HIVE account, which is
      what would let an unlinked identity become a trusted one
- [ ] Channel capability degradation matrix + tests (no buttons on Slack, no threads on Telegram)
- [ ] Discord over the Gateway once there is a worker that can hold a socket, so it is a
      conversation rather than a slash command
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
| I7 | Every provider adapter runs the shared conformance suite (AC-14) |
| I8 | No unscoped tenant query (command-monitoring guard throws) |
| I9 | Prompt prefix is byte-stable across identical state |
| I10 | No secret reachable from run / step / event / audit / log |
