# Salvations — Implementation Roadmap

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md). Section references (§) point there.

**Current state:** Phase 0 complete (architecture proposed). **No application code has been
written.** Implementation starts only after the architecture is signed off.

**Legend:** `[ ]` todo · `[~]` in progress · `[x]` done · **(AC)** = acceptance-criteria item from
§15.3 · 🔒 = security-critical, requires review

---

## Phase 0 — Architecture & sign-off  ✅

- [x] Inspect repository (empty; git initialised, zero commits)
- [x] Verify current MCP specification revision (`2026-07-28`) and its breaking changes
- [x] Verify official MCP SDK + transport approach (TypeScript SDK **V2**, split packages,
      Streamable HTTP + stdio, HTTP+SSE deprecated)
- [x] Verify MCP authorization direction (OAuth 2.1 resource server, RFC 9728 / 8707 / 9207,
      DCR → CIMD)
- [x] Verify provider landscape and current model identifiers
- [x] Propose technical architecture, DB schema, authn/authz, MCP client, `AgentProvider`,
      Agent Runtime, multi-tenancy, folder structure
- [x] Identify architectural risks (R1–R14) and spec conflicts (§14)
- [x] Define Phase 1 plan and definition of done
- [ ] **Architecture sign-off from the product owner** ← *gate: nothing below starts until this is done*
- [ ] Open ADR-0001 … ADR-0010 in `docs/adr/` capturing each decision in §3, §7, §9

---

## Phase 1 — Vertical slice: the abstractions, proven

> Goal: one conversation, three providers, one real third-party MCP server, real permissions.
> Not feature breadth — load-bearing depth.

### 1.1 Repository foundation

- [ ] pnpm workspace + Turborepo; Node 22 LTS pinned via `.nvmrc` / `engines`
- [ ] `tsconfig.base.json` — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- [ ] Package skeletons per §12 (`core`, `runtime`, `providers/*`, `mcp`, `db`, `crypto`,
      `contracts`, `observability`, `channels`, `apps/{api,worker,web}`)
- [ ] 🔒 `.dependency-cruiser.cjs` enforcing the §4.2 dependency rule
- [ ] 🔒 Custom ESLint rule `no-provider-branching` in `tools/eslint-rules`
- [ ] 🔒 CI guard scripts implementing **(AC-11)** and **(AC-12)** — grep gates on
      `packages/runtime` + `packages/core`
- [ ] `docker-compose.yml`: postgres 17 + pgvector, redis/valkey, minio
- [ ] CI: typecheck · lint · boundary check · unit · integration (testcontainers) · grep gates
- [ ] Vitest setup; `packages/testkit` shared fixtures

### 1.2 Database (§5)

- [ ] Drizzle schema for identity/tenancy/access (`users`, `sessions`, `accounts`, `workspaces`,
      `workspace_members`, `workspace_invitations`, `api_keys`)
- [ ] Schema: `credentials`, `oauth_connections`
- [ ] Schema: `provider_configs`, `model_bindings`
- [ ] Schema: `agents`, `agent_versions`, `agent_capability_bindings`
- [ ] Schema: `mcp_servers`, `mcp_server_bindings`, `mcp_capabilities`,
      `mcp_capability_approvals`, `tool_permissions`, `mcp_connection_health`
- [ ] Schema: `conversations`, `messages`, `runs`, `run_steps`, `tool_invocations`,
      `approvals`, `run_events`
- [ ] Schema: `conversation_summaries`, `outbox`, `channels`, `channel_identities`,
      `channel_events`, `audit_log`, `usage_records`
- [ ] UUIDv7 generation helper; migration + seed scripts
- [ ] 🔒 **RLS policies on every tenant-scoped table**, keyed on `app.workspace_id`
- [ ] 🔒 Restricted application DB role (no `BYPASSRLS`); separate migration role
- [ ] Repository layer requiring a `WorkspaceScope`; `SET LOCAL app.workspace_id` per transaction
- [ ] 🔒 **(AC-10)** Test: unscoped query under the app role returns zero rows
- [ ] `audit_log` hardening: no `UPDATE`/`DELETE` grant to the app role

### 1.3 Crypto & secrets (§6.5)

- [ ] `KeyProvider` port + `LocalFileKeyProvider`; `KmsKeyProvider` interface stub
- [ ] 🔒 Envelope encryption service (AES-256-GCM, per-credential DEK, wrapped by workspace KEK)
- [ ] `CredentialResolver` returning short-lived non-serialisable handles
- [ ] 🔒 Redaction utilities (schema-driven + entropy heuristic) used by
      `tool_invocations.arguments_redacted` and the logger
- [ ] 🔒 Test: no plaintext secret appears in any `runs` / `run_steps` / `audit_log` / log line
- [ ] KEK rotation path (`kek_version`, incremental online re-wrap)

### 1.4 Auth & authorization (§6)

- [ ] Better Auth wired to our Postgres (email/password + one OAuth provider, TOTP 2FA)
- [ ] Workspace creation, invitations, membership, role assignment
- [ ] API keys: `sk_<prefix>_<secret>`, SHA-256 storage, constant-time compare, async `last_used_at`
- [ ] `Principal` resolution middleware; `WorkspaceScope` derivation
- [ ] RBAC permission sets per role; route guards
- [ ] 🔒 `PermissionBroker` (§6.4) — full evaluation order, fail-closed default `ask`
- [ ] 🔒 Delegation rule: `effective(agent) = agentVersion ∩ onBehalfOf ∩ workspacePolicy`
- [ ] 🔒 `PermissionBroker` unit tests incl. deny-wins, specificity ordering, annotation-as-floor

### 1.5 `AgentProvider` abstraction (§7)

- [ ] `packages/core/src/ports/agent-provider.ts` — port, `ModelCapabilities`,
      `GenerationRequest`, `ProviderEvent`, canonical `ContentBlock`
- [ ] Canonical message serialisation + `provider_artifacts` sidecar semantics (§7.4)
- [ ] `packages/providers/testkit` — **conformance suite written before any adapter**:
      golden conversations, tool round-trips, parallel tool calls, streaming order,
      error taxonomy, schema down-conversion, artifact replay/drop
- [ ] Anthropic adapter (`@anthropic-ai/sdk`) — adaptive thinking + `output_config.effort`,
      explicit `cache_control` breakpoints, no prefill, thinking-block replay rules
- [ ] OpenAI adapter (`openai`)
- [ ] Google adapter (`@google/genai`)
- [ ] Provider registry (`provider_type` → factory); `model_bindings.capabilities` cache +
      refresh job
- [ ] Cost calculation from `model_bindings` rates → `usage_records`
- [ ] 🔒 Test: every adapter passes the conformance suite identically

### 1.6 MCP client layer (§9)

- [ ] `@modelcontextprotocol/client@2` wired; Streamable HTTP transport
- [ ] `versionNegotiation: 'auto'`; persist `negotiated_protocol_version` per binding
- [ ] `McpServerRegistry` + `McpConnectionFactory` + `ConnectionScopeKey` typing
- [ ] `McpClientManager`: per-binding concurrency semaphore, circuit breaker,
      `mcp_connection_health`
- [ ] 🔒 `McpOAuthClient`: RFC 9728 discovery, PKCE, **CIMD `client_id`** (+ hosted
      `/.well-known/mcp-client-metadata.json`), **RFC 8707 `resource` indicator**,
      **RFC 9207 issuer validation**, DCR fallback, refresh + revocation
- [ ] `CapabilityDiscovery`: `server/discover` → `tools/list`; honour `ttlMs`
- [ ] 🔒 `cacheScope` handling — shareable vs per-user cache keys, **fail closed when absent** (R4)
- [ ] `CapabilityStore`: normalise, `definition_hash`, diff (new/changed/removed), soft-delete
- [ ] 🔒 Approval invalidation on `definition_hash` change (R2) + **(AC-7)**
- [ ] `ToolGateway`: resolve → permit → validate (Ajv 2020-12) → invoke → normalise → audit
- [ ] Capability namespacing `alias__tool` + provider-legal transform with hash suffix (§9.6)
- [ ] MRTR: `input_required` → classify → human path suspends the run; 🔒 **inference path denied
      by default** (R3); `requestState` echoed verbatim, never parsed or logged in full
- [ ] Result size capping + blob-store spill
- [ ] 🔒 Test: two users on a `per_user_auth` binding never share a discovery cache entry

### 1.7 Agent Runtime (§8)

- [ ] `RunBudget` + `BudgetMeter` (steps, tool calls, tokens, wall clock, cost, MRTR rounds)
- [ ] `Resolver` — pin `agent_version`, `model_binding`, principal, budget
- [ ] `ContextAssembler` with the fixed cache-stable ordering (§8.3)
- [ ] 🔒 Prefix-stability CI test: two builds of identical state produce byte-identical prefixes (R9)
- [ ] `CapabilitySelector` incl. pre-filtering denied capabilities before the model sees them
- [ ] `ModelCall` phase: streaming → `run_events`, retry w/ jitter, fallback model binding
- [ ] `ToolPhase`: parallel execution, **all results in one tool message**, denial-as-tool-error
- [ ] Step persistence; `U(run_id, seq)`; idempotent step replay
- [ ] Suspension states (`waiting_approval`, `waiting_input`, `waiting_tool`) + resumption
- [ ] Compaction at threshold → `conversation_summaries` + `compaction` step
- [ ] Loop detection on repeated identical tool calls (R7)
- [ ] Per-agent and per-workspace kill switch
- [ ] 🔒 **(AC-9)** Test: kill a worker mid-run; another resumes without duplicate side effects
- [ ] 🔒 **(AC-8)** Test: budget exhaustion → clean partial result + accurate cost record
- [ ] 🔒 **(AC-6)** Test: continue one conversation across Anthropic → OpenAI → Google;
      artifacts replay on same-model, drop on cross-model

### 1.8 Background execution

- [ ] BullMQ queues: `run`, `discovery`, `outbox`, `mcp-task` (+ priority tiers)
- [ ] Transactional outbox + dispatcher (never enqueue inside a DB transaction)
- [ ] `apps/worker` composition root + processors
- [ ] Run heartbeat + stalled-run reclamation
- [ ] Per-workspace rate limits / queue groups (R13)

### 1.9 API & web channel

- [ ] `apps/api` Hono composition root; `packages/contracts` Zod schemas shared with web
- [ ] Routes: auth, workspaces, members, api-keys, provider-configs, model-bindings, agents,
      mcp-servers, mcp-bindings, capabilities, approvals, permissions, conversations, runs,
      credentials, health
- [ ] SSE run-event stream with cursor-based replay from `run_events`
- [ ] `apps/web` (Next.js 16): auth pages, workspace switcher, agent editor, chat with token
      streaming, run timeline (steps + tool calls + usage/cost), MCP install + OAuth flow,
      capability approval UI **with definition diffs**, permission editor, approval modal
- [ ] Web `ChannelAdapter` implementation

### 1.10 Observability

- [ ] OTel tracing: run → step → model call → tool call (span per MCP request)
- [ ] Structured JSON logging with 🔒 redaction middleware
- [ ] `audit_log` writer used by `PermissionBroker`, `ToolGateway`, credential access, admin actions
- [ ] `usage_records` + cost dashboards; 🔒 cache-hit-rate alert (R9)
- [ ] Health/readiness endpoints; DB + Redis + provider reachability checks

### 1.11 Phase 1 exit

- [ ] All twelve **(AC)** criteria in §15.3 green in CI
- [ ] Threat model review against R1–R14 documented in `docs/adr/`
- [ ] Runbooks: credential rotation, stuck run, MCP server outage, cost spike

---

## Phase 2 — Memory, documents & RAG

- [ ] `MemoryStore` / `VectorStore` / `DocumentStore` ports
- [ ] `chunk_embeddings_<D>` sidecar tables + HNSW indexes (§5.3)
- [ ] `collections`, `documents`, `document_chunks` + `tsv` generated column
- [ ] Resumable ingestion pipeline: fetch → extract → chunk → embed → index, per-stage checkpoints
- [ ] Extractors: PDF, DOCX, HTML, Markdown, plain text
- [ ] Hybrid retrieval: HNSW + full-text, fused with RRF; optional rerank via the `cheap` model role
- [ ] Bitemporal `memory_entries` (supersede, never update) + `memory_write` run steps
- [ ] Memory scopes: workspace / agent / user / conversation
- [ ] Ingest documents from **MCP resources** (`source_type = 'mcp_resource'`)
- [ ] Shadow-collection re-embedding with atomic swap (R12)
- [ ] Document ACLs enforced at retrieval time 🔒

## Phase 3 — MCP breadth

- [ ] MCP **resources** + `resources/read` exposed to the runtime as context, not tools
- [ ] MCP **prompts** surfaced as agent-selectable templates
- [ ] `subscriptions/listen` opt-in → live `list_changed` invalidation
- [ ] **Tasks extension**: `tasks/get` / `tasks/update` / `tasks/cancel`; `waiting_tool` resumption
- [ ] 🔒 **stdio transport, sandboxed** (R6): container, read-only rootfs, no ambient credentials,
      egress allowlist, CPU/memory/PID caps — first-party & verified servers only in hosted tier
- [ ] Platform MCP catalog (`workspace_id IS NULL`) + one-click install
- [ ] `trust_tier` driven approval defaults + risk-tiered UX (R14)
- [ ] Scoped remembered approvals ("allow with these arg constraints for 24h")

## Phase 4 — Scheduling, orchestration & Telegram

- [ ] `schedules` + `schedule_runs`; BullMQ repeatable jobs; `overlap_policy`
- [ ] 🔒 Schedule principal re-validation on each firing (fail closed when the creator loses access)
- [ ] Timezone/DST-correct cron; next-run preview in the UI
- [ ] `spawn_subagent` as a permission-gated first-party MCP capability
- [ ] Sub-agent budget carving + `maxSubagentDepth` enforcement
- [ ] Telegram `ChannelAdapter`: webhook + secret verification 🔒, throttled message edits,
      inline-keyboard approvals, file handling
- [ ] 🔒 `channel_identities` linking flow; unlinked identities are minimal-privilege
- [ ] Channel capability degradation matrix + tests

## Phase 5 — First-party MCP servers (dogfooding, §9.7)

- [ ] `mcp-servers/memory` — semantic memory search/write
- [ ] `mcp-servers/documents` — collection retrieval
- [ ] `mcp-servers/workspace-admin` — agent/schedule management
- [ ] `mcp-servers/orchestration` — sub-agent spawning
- [ ] In-process transport for first-party servers (same client interface, same `ToolGateway`)
- [ ] 🔒 Verify no runtime back doors were added for our own servers

## Phase 6 — Platform hardening & scale

- [ ] `KmsKeyProvider` / `VaultKeyProvider` for production
- [ ] Public API + SDK; per-key rate limits and quotas
- [ ] Billing: usage metering, plan limits, per-workspace cost caps (R7)
- [ ] 🔒 Prompt-injection defence-in-depth (R1): untrusted-data framing, chain-gating by
      `trust_tier`, adversarial test corpus in CI
- [ ] Read replicas; partition `run_events` / `run_steps` / `audit_log` by time
- [ ] Data export + workspace deletion (GDPR-grade, cascading through blob store)
- [ ] SOC 2 evidence: audit completeness, access reviews, key rotation records
- [ ] Load testing: 100 concurrent runs, 50 MCP bindings, 10k-document collections
- [ ] MCP spec-upgrade drill (R10) — confirm a protocol bump touches only `packages/mcp`

---

## Standing invariants (checked in CI on every commit)

1. `packages/core` and `packages/runtime` contain **no** integration names (Gmail, Telegram,
   Notion, GitHub, Slack, …) — **(AC-11)**
2. `packages/core` and `packages/runtime` contain **no** provider names (Anthropic, OpenAI,
   Gemini, Google) — **(AC-12)**
3. `packages/runtime` does not import `packages/providers/*`, `packages/mcp/*` concretes, or
   `packages/db`
4. `packages/core` imports nothing but `zod`
5. Every tenant-scoped table has an RLS policy
6. Every new `AgentProvider` adapter passes the full conformance suite
7. Every MCP invocation path passes through `ToolGateway`
8. No secret material is reachable from `runs`, `run_steps`, `audit_log`, logs, or LLM context
