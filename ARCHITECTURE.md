# Salvations — MCP-Native Agent Host Platform

**Status:** Proposed architecture (Phase 0 — design). No application code exists yet.
**Document version:** 1.0
**Last verified against external sources:** 2026-09-15

---

## 0. Repository state at time of writing

The repository was inspected before any design work:

```
/home/user/salvations
├── .git/          (initialised, branch claude/epic-gates-clsnom, ZERO commits)
└── (nothing else)
```

There is **no existing source, package manifest, schema, CI config, or documentation**. This is a
true greenfield build, so nothing below is constrained by legacy decisions. Every choice in this
document is therefore a *first* decision, not a *migration*.

---

## 1. Product thesis and the non-negotiable architectural principle

Salvations is an **MCP-native agent host / orchestration platform**. It is explicitly *not* a
chatbot with integrations bolted on.

The layering is the product:

| Layer | Responsibility | Replaceable? |
|---|---|---|
| **Agent** | Reasoning engine only. Chooses the next action. | Yes — any provider, any model |
| **MCP** | The *only* standardized capability layer. Tools, resources, prompts. | It is the contract |
| **Agent Host** | Context, memory, permissions, execution, orchestration, budgets, audit | This is the product |
| **Channels** | User interfaces (web, Telegram, future: email/Slack/voice/API) | Yes — pluggable |
| **MCP Servers** | Extensible capability providers, first- and third-party | Yes — installable |

### 1.1 The four rules that fall out of this

1. **The Agent Runtime never names an integration.** There is no `if (tool === 'gmail')`, no
   `TelegramService` import, no Notion client anywhere inside `packages/runtime`. Integrations
   reach the runtime *only* as discovered MCP capabilities. The runtime's entire outward surface
   for capability is `ToolGateway.invoke(capabilityRef, args, ctx)`.
2. **The Agent Runtime never names a provider.** There is no `if (provider === 'anthropic')`.
   Provider differences are expressed as *data* (`ModelCapabilities`) that the runtime reads, and
   as *behaviour* inside adapters that the runtime cannot see.
3. **Conversations are stored in a canonical, provider-independent form.** Provider wire formats
   are never persisted as the source of truth. (See §7.4 — this is the single most important rule
   for vendor independence, and the easiest one to get wrong.)
4. **Every capability invocation passes a permission decision and an audit record.** No exceptions,
   including for platform-owned servers.

### 1.2 Explicit non-goals for v1

- Not a general workflow/DAG engine. Orchestration is agent-driven with deterministic guardrails.
- Not an MCP *server* marketplace. We host a catalog; we do not run third-party billing.
- Not a fine-tuning or model-training platform.
- Not a multi-region active/active system in Phase 1.

---

## 2. MCP specification verification (done before design, not after)

This section records what was verified from official sources, because several widely-held
assumptions about MCP are **now wrong**, and designing against them would be a rewrite.

### 2.1 Current specification

**The current MCP specification revision is `2026-07-28`.** It is a major architectural change, not
an incremental one. ([MCP blog, 2026-07-28 release][mcp-spec], [release candidate notes][mcp-rc])

Verified changes that directly shape this architecture:

| Change | Detail | Impact on us |
|---|---|---|
| **Stateless protocol core** | The `initialize`/`initialized` handshake and the `Mcp-Session-Id` header are **removed**. Each request carries its own protocol version, client identity, and capabilities in a `_meta` envelope — e.g. `_meta: { "io.modelcontextprotocol/clientInfo": { name, version } }` — plus an `MCP-Protocol-Version: 2026-07-28` header. | Our connection pool must **not** model a remote MCP server as a stateful session. Pooling collapses to HTTP keep-alive + token cache. Servers can sit behind plain round-robin load balancers. |
| **`server/discover`** | Replaces the removed handshake for up-front capability fetch. | Our discovery service calls `server/discover`, not `initialize`. |
| **Header-based routing** | `Mcp-Method` and `Mcp-Name` headers are required; servers reject requests where headers and body disagree. | Our egress gateway/WAF can route, meter and rate-limit on headers. Also means we must not strip these headers in any proxy we own. |
| **Cacheable list results** | `tools/list`, `prompts/list`, `resources/list`, `resources/read` return `ttlMs` and `cacheScope`. | Discovery cache is spec-driven, not guessed. **`cacheScope` is a tenancy-safety field** — see risk R4. |
| **Multi-Round-Trip Requests (MRTR)** | Replaces server-initiated `sampling`/`elicitation`. Server returns `resultType: "input_required"` with `inputRequests` and an opaque base64 `requestState`; the client re-issues the original call with `inputResponses` plus the echoed state. | Human-in-the-loop and server-requested inference become a **runtime loop**, not a reverse-RPC channel. This is much easier to secure and to suspend/resume. |
| **Roots, Sampling, Logging deprecated** | Annotation-only deprecation; a formal 12-month minimum deprecation window applies. | Do not build features on them. Provide MRTR paths instead. |
| **Tasks are now an extension** | Poll-based: `tasks/get`, `tasks/update`, cooperative `tasks/cancel`. Breaking vs. the 2025-11-25 experimental Tasks API. | Long-running tools map to our job queue via polling, not open streams. |
| **JSON Schema 2020-12** | `inputSchema` / `outputSchema` lifted to full JSON Schema 2020-12. Input schemas keep an `object` root but allow `oneOf`/`anyOf`/`allOf`/conditionals/`$ref`. `outputSchema` is unrestricted and `structuredContent` may be any JSON value. | Our validator must be a real 2020-12 validator (Ajv 2020), and our provider adapters must **down-convert** schemas for providers that only accept a restricted subset. |
| **Subscriptions** | Change notifications move from the HTTP GET stream to a single `subscriptions/listen` stream, opted into per notification type. | `list_changed` handling is an explicit opt-in subscription, and is optional for us in Phase 1 (we can rely on `ttlMs`). |
| **Transports** | `stdio` and **Streamable HTTP** are current. The legacy HTTP+SSE transport is **officially deprecated** with a 12-month off-ramp. | Build Streamable HTTP first; stdio second and sandboxed; never build HTTP+SSE. |

### 2.2 Authorization changes

- MCP servers are formally **OAuth 2.1 resource servers** and MUST implement **RFC 9728**
  (OAuth 2.0 Protected Resource Metadata) so clients can discover the authorization server.
- Clients MUST implement **RFC 8707 Resource Indicators** so a token minted for server A cannot be
  replayed against server B.
- **RFC 9207** issuer validation is mandatory (authorization-server mix-up defence), and client
  credentials are bound to the issuer that minted them.
- **Dynamic Client Registration (DCR) is formally deprecated** in favour of **Client ID Metadata
  Documents (CIMD)**, where `client_id` is an HTTPS URL pointing at a JSON metadata document the
  client self-hosts. DCR keeps working for at least 12 months.
- `application_type` is supported at registration so desktop/CLI clients get correct localhost
  handling.

**Consequence:** Salvations must **host a CIMD document** at a stable HTTPS URL (e.g.
`https://<host>/.well-known/mcp-client-metadata.json`) and use that URL as its `client_id`. We keep
a DCR fallback for servers that have not migrated. Every token request carries a `resource`
indicator naming the exact MCP server.

### 2.3 SDK and transport decision

Verified against the npm registry on 2026-09-15:

| Package | Latest | Notes |
|---|---|---|
| `@modelcontextprotocol/client` | **2.0.0** (published 2026-07-28) | V2 client, deps incl. `zod@^4`, `jose@^6`, `pkce-challenge@^5` |
| `@modelcontextprotocol/server` | **2.0.0** | For our own first-party MCP servers |
| `@modelcontextprotocol/node` | **2.0.0** | Node HTTP middleware |
| `@modelcontextprotocol/express`, `/hono`, `/fastify` | **2.0.0** | Framework adapters |
| `@modelcontextprotocol/codemod` | 2.x | v1 → v2 migration tooling |
| `@modelcontextprotocol/sdk` *(v1, monolithic)* | 1.30.0 | **Legacy.** Do not use for new code. |

**Decision: use the official TypeScript SDK V2, split packages.** TypeScript is a Tier 1 SDK
language for the 2026-07-28 spec (alongside Python, Go, C#; Rust in beta), which is a first-order
reason to build the host in TypeScript.

**Version negotiation:** the V2 `Client` speaks both eras — the legacy era (`2024-10-07` …
`2025-11-25`, `initialize` handshake) and the modern era (`2026-07-28`, `server/discover` +
`_meta`). It exposes a `versionNegotiation` option with three modes: default `legacy` (no probing),
`auto` (probe `server/discover`, fall back to `initialize`), and pinned (`{ pin: '2026-07-28' }`).

> **Our policy:** default to `auto` per binding, record the negotiated era on
> `mcp_server_bindings.negotiated_protocol_version`, and allow a per-binding pin for servers known
> to misbehave under probing. Surface the negotiated era in the UI so operators can see which of
> their servers are still legacy.

**Transport policy:**

- **Streamable HTTP** — the default and the only transport permitted for third-party servers in the
  hosted tier.
- **stdio** — permitted only for (a) local developer workstations and (b) platform-vetted
  first-party servers running inside a hardened sandbox. See risk R6.
- **HTTP+SSE** — never implemented. Deprecated upstream.

---

## 3. Technology stack

Language and runtime are chosen primarily because MCP TypeScript is a Tier 1 SDK and because one
language across API, worker, web and our own MCP servers removes an entire class of
type-drift bugs.

| Concern | Choice | Version (verified 2026-09-15) | Rationale / exit strategy |
|---|---|---|---|
| Language | TypeScript (strict), Node 22 LTS | — | Tier 1 MCP SDK; one type system end-to-end |
| Monorepo | pnpm workspaces + Turborepo | — | Enforces package boundaries; boundaries are the architecture |
| API | Hono | 4.13.x | Small, fast, runtime-portable; official `@modelcontextprotocol/hono` adapter exists for when we host our own servers |
| Web | Next.js (App Router) | 16.3.x | The web **channel**, not the platform. Talks to the API over HTTP only. |
| Database | PostgreSQL 17 + `pgvector` | pgvector 0.8+ | One durable store for relational + vector. Vector access is behind a port (§11) |
| ORM / migrations | Drizzle ORM | 0.45.x | SQL-first, no hidden runtime, migrations are reviewable SQL |
| Queue / scheduler | BullMQ on Redis (or Valkey) | bullmq 6.x | Repeatable jobs for cron, delayed jobs, per-workspace rate limits |
| Validation | Zod 4 + Ajv 2020 | zod 4.6.x | Zod for our own contracts; **Ajv 2020-12** for untrusted MCP tool schemas |
| Auth | Better Auth | 1.7.x | Self-hosted, owns its tables in *our* Postgres. No identity vendor lock-in |
| Secrets | Envelope encryption, AES-256-GCM, KEK behind a `KeyProvider` port | — | Local file KEK in dev; KMS/Vault in prod. Swappable |
| Object storage | S3-compatible behind a `BlobStore` port | — | MinIO in dev, S3/R2 in prod |
| Observability | OpenTelemetry traces + metrics, structured JSON logs | — | Vendor-neutral by construction |

**Provider SDKs** are dependencies of *adapter packages only* and are never imported outside them:
`@anthropic-ai/sdk` (0.125.x), `openai` (7.15.x), `@google/genai` (2.22.x).

### 3.1 On the Vercel AI SDK (deliberately rejected as the core abstraction)

`ai` / `@ai-sdk/*` is a good abstraction and could be used. We are **not** making it the core
`AgentProvider` port, because:

- It would make our most vendor-sensitive seam depend on a third party's model of what a "message"
  is. Our canonical message format (§7.4) is a **persistence format**, and persistence formats must
  be ours.
- It does not model the things our runtime specifically needs: provider-artifact replay rules,
  prompt-cache breakpoint budgets, per-provider schema down-conversion, and a capability descriptor
  the runtime can branch on.

It remains perfectly reasonable to implement a *single* `AgentProvider` adapter **on top of** the AI
SDK later (`packages/providers/aisdk`) to reach long-tail providers cheaply. The port makes that a
one-file decision instead of a rewrite. That is the point of the port.

---

## 4. System architecture

### 4.1 Component view

```
  ┌────────────┐   ┌──────────────┐   ┌─────────────────┐
  │  Web (Next)│   │  Telegram    │   │  Public API     │   CHANNELS
  └─────┬──────┘   └──────┬───────┘   └────────┬────────┘
        │ SSE/HTTP        │ webhook            │ API key
  ┌─────▼─────────────────▼────────────────────▼────────────────────────┐
  │                       apps/api  (Hono)                              │
  │   authn · authz · workspace resolution · channel ingress ·          │
  │   run submission · SSE event egress · admin CRUD                    │
  └───────────────┬──────────────────────────┬──────────────────────────┘
                  │ transactional outbox     │ subscribe
          ┌───────▼──────────┐       ┌───────▼───────────┐
          │  Redis / BullMQ  │       │  Run event bus    │
          └───────┬──────────┘       └───────▲───────────┘
                  │ consume                  │ publish
  ┌───────────────▼──────────────────────────┴──────────────────────────┐
  │                     apps/worker                                     │
  │  ┌───────────────────────────────────────────────────────────────┐  │
  │  │              packages/runtime — AGENT RUNTIME                 │  │
  │  │  Resolver → ContextAssembler → CapabilitySelector →           │  │
  │  │  ModelCall → ToolPhase → Persist → loop / suspend             │  │
  │  └───────┬──────────────────┬───────────────────┬────────────────┘  │
  │          │                  │                   │                   │
  │  ┌───────▼───────┐  ┌───────▼────────┐  ┌───────▼───────────────┐   │
  │  │ AgentProvider │  │  ToolGateway   │  │ Memory / Retrieval    │   │
  │  │    (port)     │  │ + Permission-  │  │       (ports)         │   │
  │  └───────┬───────┘  │   Broker       │  └───────┬───────────────┘   │
  │          │          └───────┬────────┘          │                   │
  └──────────┼──────────────────┼───────────────────┼───────────────────┘
             │                  │                   │
   ┌─────────▼──────┐  ┌────────▼─────────┐  ┌──────▼──────────────┐
   │ anthropic /    │  │ packages/mcp     │  │ Postgres + pgvector │
   │ openai /       │  │ MCP Client Mgr   │  │ Blob store          │
   │ google adapters│  └────────┬─────────┘  └─────────────────────┘
   └────────────────┘           │ Streamable HTTP / stdio
                       ┌────────▼──────────────────────────┐
                       │ MCP SERVERS (1st + 3rd party)     │
                       └───────────────────────────────────┘
```

### 4.2 Dependency rule (enforced in CI)

```
core  ←  runtime  ←  apps
  ↑         ↑
  └── mcp, providers, memory, channels, db
```

- `packages/core` has **zero** runtime dependencies beyond `zod`. It defines entities, value
  objects, ports (interfaces), and pure policy logic. It cannot import Postgres, HTTP, or any SDK.
- `packages/runtime` depends on `core` **ports only**. It never imports `packages/providers/*`,
  `packages/mcp` concrete classes, or `packages/db`. It receives implementations by injection.
- `apps/*` are composition roots: they are the only place where concrete adapters are wired to
  ports.

This is enforced with `eslint-plugin-boundaries` + a `dependency-cruiser` rule in CI. A violation
fails the build. Architecture that is not enforced is a wish.

### 4.3 Request → run flow (the canonical path)

1. Channel receives input (web POST, Telegram webhook, API call).
2. `apps/api` authenticates the principal, resolves the workspace, and normalises to an
   `InboundMessage`.
3. API appends a `user` message to the conversation and creates a `run` row in status `queued`,
   **in one transaction**, together with an `outbox` row. (Transactional outbox — never enqueue to
   Redis inside a DB transaction.)
4. Outbox dispatcher moves the job to BullMQ.
5. `apps/worker` claims the run, instantiates `AgentRuntime` with injected adapters, and executes
   the step loop (§8).
6. Each step is persisted before the next begins. Run events are published to the event bus.
7. Channels subscribe to run events and render them (SSE for web, message edits for Telegram).
8. Run terminates (`succeeded` / `failed` / `cancelled`) or **suspends** (`waiting_approval`,
   `waiting_input`, `waiting_tool`). Suspended runs hold no process memory.

---

## 5. Data architecture

PostgreSQL 17. All identifiers are UUIDv7 (time-sortable, index-friendly). All tenant-scoped tables
carry `workspace_id` as the **first** column of their primary composite indexes.

### 5.1 Tenancy model

- **`workspaces` are the tenant boundary.** Every domain row belongs to exactly one workspace.
- **Defence in depth, two layers:**
  1. **Application layer:** all data access goes through repositories that take a
     `WorkspaceScope` and cannot be constructed without one.
  2. **Database layer:** PostgreSQL **Row-Level Security** on every tenant-scoped table, with
     policies keyed on `current_setting('app.workspace_id')`. The repository layer sets this GUC
     via `SET LOCAL` at the start of every transaction. The application database role is **not**
     `BYPASSRLS`. A separate migration role is.

  Either layer alone is a single point of failure. Together, a forgotten `WHERE workspace_id = ?`
  returns zero rows instead of another tenant's data.

- **Users are global; membership is per workspace.** One human, one `users` row, N workspaces.

### 5.2 Schema

Notation: `PK`, `FK`, `U` = unique, `N` = nullable. `jsonb` throughout for open extension points.

#### Identity, tenancy, access

```
users                 id PK, email U, email_verified, name, image, created_at, updated_at
accounts              id PK, user_id FK, provider, provider_account_id, U(provider,provider_account_id),
                      access_token_enc, refresh_token_enc, expires_at        -- Better Auth social
sessions              id PK, user_id FK, token U, expires_at, ip, user_agent -- Better Auth
verifications         id PK, identifier, value, expires_at

workspaces            id PK, slug U, name, plan, settings jsonb, created_by FK users,
                      created_at, deleted_at N
workspace_members     workspace_id FK, user_id FK, role, status, invited_by N, joined_at
                      PK(workspace_id, user_id)
workspace_invitations id PK, workspace_id FK, email, role, token U, invited_by, expires_at,
                      accepted_at N
api_keys              id PK, workspace_id FK, name, prefix U, key_hash, scopes jsonb,
                      created_by FK, last_used_at N, expires_at N, revoked_at N
```

`role ∈ {owner, admin, member, viewer}`. Roles expand to permission sets in code, not in the DB, so
permissions can be refactored without a migration.

#### Credentials and external identity

```
credentials           id PK, workspace_id FK, name, kind, ciphertext bytea, wrapped_dek bytea,
                      iv bytea, auth_tag bytea, key_provider, kek_version, metadata jsonb,
                      created_by, created_at, rotated_at N, revoked_at N
                      -- kind ∈ {api_key, oauth2_token, basic, header, custom}
                      -- plaintext NEVER stored; see §6.5

oauth_connections     id PK, workspace_id FK, user_id FK N, issuer, subject, resource_indicator,
                      scopes text[], access_credential_id FK credentials,
                      refresh_credential_id FK credentials N, expires_at, created_at,
                      U(workspace_id, issuer, subject, resource_indicator, coalesce(user_id,...))
                      -- user_id NULL  => workspace-shared service connection
                      -- user_id SET   => per-user connection (the default for user-facing servers)
```

#### AI providers and models (vendor-independent by construction)

```
provider_configs      id PK, workspace_id FK, provider_type, name, credential_id FK N,
                      base_url N, settings jsonb, enabled, created_at
                      -- provider_type ∈ {anthropic, openai, google, openai_compatible,
                      --                  bedrock, vertex, foundry, azure_openai, local}

model_bindings        id PK, workspace_id FK, provider_config_id FK, model_id, display_name,
                      role, params jsonb, capabilities jsonb, capabilities_fetched_at N,
                      cost_input_per_mtok, cost_output_per_mtok, cost_cache_read_per_mtok N,
                      enabled, U(workspace_id, provider_config_id, model_id, role)
                      -- role ∈ {chat, reasoning, embedding, summarizer, judge, cheap}
                      -- params is the ONLY place provider knobs live: {effort, thinking,
                      --   temperature, maxOutputTokens, ...}. Adapters read it; runtime does not.
```

`model_bindings.role` is what makes the platform swappable at the *deployment* level: an agent
references a role, the workspace maps roles to bindings.

#### Agents

```
agents                id PK, workspace_id FK, slug, name, description, is_archived,
                      current_version_id FK N, created_by, created_at,
                      U(workspace_id, slug)

agent_versions        id PK, agent_id FK, version int, snapshot jsonb, changelog N,
                      created_by, created_at, U(agent_id, version)
                      -- snapshot is the FULL immutable config: system prompt, model role
                      --   preferences, capability selection, budgets, memory policy,
                      --   guardrails. Runs pin to an agent_version_id — editing an agent
                      --   never mutates an in-flight or historical run.

agent_capability_bindings
                      id PK, agent_id FK, mcp_binding_id FK, selection jsonb, priority,
                      U(agent_id, mcp_binding_id)
                      -- selection: { mode: 'all'|'allow'|'deny', tools: string[],
                      --              resources: string[], prompts: string[] }
                      -- THIS is MCP server reuse: many agents → one mcp_server_binding.

agent_collections     agent_id FK, collection_id FK, mode, PK(agent_id, collection_id)  -- RAG
```

#### MCP layer

```
mcp_servers           id PK, workspace_id FK N, slug, name, description, transport,
                      url N, command N, args jsonb N, env_template jsonb N,
                      auth_mode, auth_config jsonb, trust_tier, protocol_version_pin N,
                      publisher, homepage N, created_by N, created_at,
                      U(coalesce(workspace_id,'0'), slug)
                      -- workspace_id NULL  => PLATFORM CATALOG entry (shared definition)
                      -- workspace_id SET   => workspace-private server definition
                      -- transport ∈ {streamable_http, stdio}
                      -- auth_mode ∈ {none, oauth2, header, passthrough}
                      -- trust_tier ∈ {first_party, verified, community, untrusted}

mcp_server_bindings   id PK, workspace_id FK, mcp_server_id FK, alias,
                      credential_id FK N, per_user_auth bool, config_overrides jsonb,
                      status, negotiated_protocol_version N, last_discovery_at N,
                      last_error jsonb N, enabled, created_by, created_at,
                      U(workspace_id, alias)
                      -- A binding = "this workspace's installation of this server,
                      --   with these credentials". Agents attach to BINDINGS.
                      -- alias is the tool-namespace prefix (see §9.6).

mcp_capabilities      id PK, binding_id FK, workspace_id FK, kind, name, title N, description N,
                      input_schema jsonb N, output_schema jsonb N, annotations jsonb N,
                      uri_template N, definition_hash, ttl_ms N, cache_scope N,
                      first_seen_at, last_seen_at, removed_at N,
                      U(binding_id, kind, name)
                      -- kind ∈ {tool, resource, resource_template, prompt}
                      -- definition_hash = sha256 over the normalised definition.
                      --   Change of hash ⇒ re-approval required (rug-pull defence, R2).

mcp_capability_approvals
                      id PK, workspace_id FK, binding_id FK, capability_name,
                      definition_hash, approved_by FK users, approved_at, revoked_at N,
                      U(binding_id, capability_name, definition_hash)

tool_permissions      id PK, workspace_id FK, scope_type, scope_id N, binding_id FK N,
                      capability_pattern, effect, constraints jsonb, priority int,
                      created_by, created_at
                      -- scope_type ∈ {workspace, agent, member, api_key, channel}
                      -- effect ∈ {allow, deny, ask}
                      -- constraints: { argMatchers, maxCallsPerRun, maxCallsPerHour,
                      --                allowedHours, requireApprovalOver: {...} }

mcp_connection_health binding_id PK FK, last_ok_at N, last_error_at N, last_error jsonb N,
                      consecutive_failures int, circuit_state, circuit_opened_at N
```

#### Conversations, runs, steps (provider-independent)

```
conversations         id PK, workspace_id FK, agent_id FK, channel_id FK N,
                      external_ref N, title N, status, created_by N, created_at, updated_at,
                      U(channel_id, external_ref)          -- channel idempotency

messages              id PK, conversation_id FK, workspace_id FK, seq bigint, role,
                      content jsonb,                        -- CANONICAL blocks (§7.4)
                      provider_artifacts jsonb N,           -- keyed "provider:model" (§7.4)
                      token_estimate int N, run_id FK N, created_at,
                      U(conversation_id, seq)
                      -- APPEND-ONLY. Edits create a new message + a tombstone.

runs                  id PK, workspace_id FK, conversation_id FK, agent_version_id FK,
                      model_binding_id FK, trigger_type, trigger_ref N, principal jsonb,
                      status, input jsonb, output jsonb N, error jsonb N,
                      budget jsonb, usage jsonb, cost_usd numeric(12,6),
                      idempotency_key N, parent_run_id FK N, depth int,
                      queued_at, started_at N, finished_at N, heartbeat_at N,
                      U(workspace_id, idempotency_key)
                      -- status ∈ {queued, running, waiting_approval, waiting_input,
                      --           waiting_tool, succeeded, failed, cancelled, expired}
                      -- parent_run_id + depth: bounded sub-agent orchestration

run_steps             id PK, run_id FK, workspace_id FK, seq int, type, status,
                      request jsonb, response jsonb N, error jsonb N,
                      usage jsonb N, latency_ms N, started_at, finished_at N,
                      U(run_id, seq)
                      -- type ∈ {model_call, tool_call, memory_read, memory_write,
                      --         retrieval, compaction, input_required, subagent}

tool_invocations      id PK, run_step_id FK, workspace_id FK, binding_id FK N,
                      capability_name, arguments_redacted jsonb, result_ref N,
                      result_inline jsonb N, is_error bool, permission_decision,
                      approval_id FK N, mcp_task_id N, mrtr_rounds int,
                      duration_ms, created_at

approvals             id PK, workspace_id FK, run_id FK, run_step_id FK N, kind,
                      payload jsonb, requested_at, expires_at, decided_at N,
                      decided_by FK users N, decision N, response jsonb N
                      -- kind ∈ {tool_call, mrtr_input, budget_increase, capability_change}

run_events            id PK, run_id FK, workspace_id FK, seq int, type, payload jsonb,
                      created_at, U(run_id, seq)
                      -- durable event log; SSE replays from a cursor after reconnect
```

#### Memory

```
memory_entries        id PK, workspace_id FK, scope_type, scope_id, kind, key N,
                      content text, importance real, source_run_id FK N,
                      valid_from, valid_to N, superseded_by FK N, metadata jsonb,
                      created_at
                      -- scope_type ∈ {workspace, agent, user, conversation}
                      -- kind ∈ {fact, preference, instruction, summary, episodic}
                      -- Bitemporal: never UPDATE, always supersede. Auditable memory.

memory_embeddings     memory_id PK FK, workspace_id FK, model_binding_id FK,
                      embedding vector(D)       -- see §5.3 on dimensions

conversation_summaries id PK, conversation_id FK, workspace_id FK, up_to_seq bigint,
                      content text, token_estimate int, model_binding_id FK, created_at,
                      U(conversation_id, up_to_seq)
```

#### Documents / RAG

```
collections           id PK, workspace_id FK, name, description N,
                      embedding_model_binding_id FK, embedding_dim int,
                      chunking jsonb, visibility, created_by, created_at,
                      U(workspace_id, name)

documents             id PK, collection_id FK, workspace_id FK, source_type, source_ref N,
                      title, mime_type, blob_key N, checksum, byte_size,
                      status, error jsonb N, metadata jsonb, acl jsonb N,
                      created_by N, created_at, indexed_at N,
                      U(collection_id, checksum)
                      -- source_type ∈ {upload, url, mcp_resource, connector}
                      -- mcp_resource: a document ingested from an MCP server's resources/read

document_chunks       id PK, document_id FK, collection_id FK, workspace_id FK, ordinal int,
                      content text, token_estimate int, metadata jsonb,
                      tsv tsvector GENERATED,            -- lexical half of hybrid search
                      U(document_id, ordinal)

chunk_embeddings_<D>  chunk_id PK FK, workspace_id FK, collection_id FK,
                      embedding vector(D)                -- one table per dimension, §5.3
```

#### Scheduling, background work, channels, audit

```
schedules             id PK, workspace_id FK, agent_id FK, name, cron, timezone,
                      payload jsonb, enabled, next_run_at, last_run_at N, last_run_id FK N,
                      overlap_policy, created_by, created_at
                      -- overlap_policy ∈ {skip, queue, cancel_previous}

schedule_runs         id PK, schedule_id FK, run_id FK N, fired_at, status, error jsonb N,
                      U(schedule_id, fired_at)           -- cron idempotency

outbox                id PK, workspace_id FK N, topic, payload jsonb, available_at,
                      attempts int, locked_until N, status, last_error N, created_at

channels              id PK, workspace_id FK, type, name, config jsonb, credential_id FK N,
                      webhook_secret_credential_id FK N, enabled, created_by, created_at
                      -- type ∈ {web, telegram, api, email, slack, ...}

channel_identities    id PK, channel_id FK, workspace_id FK, external_user_id,
                      user_id FK N, display_name N, linked_at N, link_token N,
                      trust_level, created_at, U(channel_id, external_user_id)
                      -- user_id NULL ⇒ UNLINKED ⇒ minimal privilege (see §6.4)

channel_events        id PK, channel_id FK, external_event_id, payload jsonb,
                      received_at, processed_at N, U(channel_id, external_event_id)

audit_log             id PK, workspace_id FK N, actor_type, actor_id N, action,
                      subject_type, subject_id N, metadata jsonb, ip N, user_agent N,
                      created_at                          -- append-only, no UPDATE/DELETE grant

usage_records         id PK, workspace_id FK, run_id FK N, model_binding_id FK N,
                      input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                      cost_usd numeric(12,6), occurred_at
```

### 5.3 The pgvector dimension problem (called out explicitly)

`pgvector` requires a **fixed dimension** on an indexable column, but embedding models differ
(1536, 3072, 768, 1024 …). Storing `vector` without a dimension is legal but **cannot be indexed**,
which silently destroys retrieval performance.

**Decision:** sidecar tables per dimension — `chunk_embeddings_768`, `chunk_embeddings_1536`,
`chunk_embeddings_3072` — each with an HNSW index. A `collection` pins exactly one
`embedding_dim`; the repository routes to the right table from `collections.embedding_dim`. Adding
a dimension is a small migration, not a redesign. Re-embedding a collection under a new model is an
explicit, resumable background job that writes to a shadow collection and atomically swaps.

### 5.4 Key relationships worth stating plainly

- `workspace 1—N agents`, `workspace 1—N mcp_server_bindings`
- **`agent N—M mcp_server_binding`** via `agent_capability_bindings` — *this is MCP server reuse.*
  One Gmail binding, ten agents, one set of credentials, ten different tool selections.
- `mcp_server 1—N mcp_server_bindings` — one catalog definition, many workspace installations.
- `run N—1 agent_version` (pinned, immutable) and `run N—1 model_binding` — *a run records exactly
  which brain and which config produced it.*
- `conversation 1—N messages` (append-only) and `conversation 1—N runs` — **a conversation outlives
  any provider.** Swapping `model_binding` mid-conversation is a normal operation.

---

## 6. Authentication and authorization architecture

### 6.1 Principals

Everything that can act is a `Principal`:

```ts
type Principal =
  | { type: 'user';             userId: string; workspaceId: string; role: Role }
  | { type: 'api_key';          apiKeyId: string; workspaceId: string; scopes: Scope[] }
  | { type: 'channel_identity'; identityId: string; workspaceId: string;
                                userId?: string; trust: 'linked' | 'unlinked' }
  | { type: 'agent';            agentId: string; runId: string; workspaceId: string;
                                onBehalfOf: Principal }          // delegated, never ambient
  | { type: 'system';           reason: 'schedule' | 'migration' | 'maintenance';
                                workspaceId: string }
```

**Delegation rule (prevents privilege escalation through agents):**

```
effective(agent) = grants(agentVersion) ∩ grants(onBehalfOf) ∩ grants(workspacePolicy)
```

An agent can never do more than the person or key that triggered it. A scheduled run's
`onBehalfOf` is the schedule's **creator**, snapshotted at creation time and re-validated on each
firing — if that user loses access or leaves the workspace, the schedule fails closed and alerts
the workspace admins. It does not silently keep running with stale privileges.

### 6.2 Authentication

| Surface | Mechanism |
|---|---|
| Web console | Better Auth sessions — httpOnly/SameSite=Lax/Secure cookies, rotating tokens, Argon2id password hashing, TOTP 2FA, OAuth social providers |
| Public API | `Authorization: Bearer sk_<prefix>_<secret>`; only a SHA-256 hash is stored; the prefix is indexed for lookup; constant-time compare; `last_used_at` written asynchronously |
| Telegram | Webhook with a secret token header + source-IP allowlist; the sender is a `channel_identity`, **unlinked by default** |
| Internal (api ↔ worker) | mTLS or a shared signed token on a private network; never the user's credentials |

**Channel identity linking:** an unlinked Telegram user is a *stranger*. They may talk to agents
explicitly marked `public`, with a restricted permission set and low rate limits. Linking requires
a one-time code generated in the web console and entered in the channel, binding
`channel_identities.user_id`. Only then do that user's workspace grants apply. This prevents "anyone
who finds the bot inherits the workspace's Gmail".

### 6.3 Authorization — three layers

1. **RBAC (coarse).** `role → Permission[]` on resource kinds (agents, MCP bindings, credentials,
   documents, schedules, settings, billing). Evaluated in the API layer.
2. **Tenant isolation (structural).** Repository `WorkspaceScope` + Postgres RLS. Not a check — an
   invariant.
3. **Capability policy (fine, the interesting layer).** `tool_permissions` rows evaluated by
   `PermissionBroker` for *every* MCP invocation.

### 6.4 PermissionBroker evaluation

Input: `(principal, agentVersion, bindingId, capabilityName, arguments, runContext)`.

```
1. Is the capability APPROVED at its current definition_hash?   ─ no  → DENY (capability_changed)
2. Collect matching tool_permissions rows across scopes:
     workspace → agent → member/api_key/channel      (all scopes, not first match)
3. Order by (priority DESC, specificity DESC)
4. Effect resolution:  any DENY wins outright
                       else most specific ASK  → require approval
                       else most specific ALLOW → allow
                       else → workspace default (default_effect, ships as 'ask')
5. Evaluate constraints: argument matchers, per-run / per-hour call caps,
   time windows, value thresholds (e.g. requireApprovalOver.amount)
6. Apply MCP tool annotations as a FLOOR, never a ceiling:
     annotations.readOnlyHint === false  ⇒ minimum effect 'ask' for untrusted trust_tiers
     (a server saying "I'm harmless" never downgrades a policy)
7. Emit audit_log + tool_invocations.permission_decision
```

Two properties matter:

- **Fail closed.** No matching rule ⇒ workspace default ⇒ ships as `ask`. A newly discovered tool is
  never silently callable.
- **Server-supplied metadata can only tighten, never loosen.** MCP annotations are hints from
  code we do not control (risk R2).

`ask` suspends the run into `waiting_approval` with an `approvals` row and emits a run event. The
channel renders it (web modal, Telegram inline keyboard). On decision, the run resumes from its
persisted step — no process was held open.

### 6.5 Credential security

- **Envelope encryption.** Per-credential random DEK → AES-256-GCM over the plaintext → DEK wrapped
  by a workspace KEK → KEK held by a `KeyProvider` (`LocalFileKeyProvider` in dev,
  `KmsKeyProvider` / `VaultKeyProvider` in prod). `key_provider` and `kek_version` are stored per
  row so rotation is incremental and online.
- **Plaintext never leaves the secret-resolution boundary.** `CredentialResolver` returns a
  short-lived, non-serialisable handle. Secrets are never in run rows, step rows, logs, traces, or
  LLM context. `tool_invocations.arguments_redacted` is redacted at write time via schema-driven
  rules plus entropy heuristics.
- **Per-user OAuth is the default for user-facing MCP servers** (`per_user_auth = true`). Every
  token request carries an **RFC 8707 `resource` indicator** naming the specific MCP server, so a
  token for server A cannot be replayed against server B. **RFC 9207** issuer validation is enforced
  on every authorization response.
- **CIMD:** we publish a Client ID Metadata Document at a stable HTTPS URL and use that URL as our
  `client_id`, with DCR retained as a fallback for servers that have not migrated (§2.2).
- **MCP servers never receive our AI-provider credentials**, and AI providers never receive our MCP
  credentials. These are two disjoint credential domains.

---

## 7. The `AgentProvider` abstraction

This is the seam that determines whether "vendor independence" is real or a slogan.

### 7.1 The port

```ts
// packages/core/src/ports/agent-provider.ts   — no SDK imports allowed in this file
export interface AgentProvider {
  readonly providerType: ProviderType;

  /** Static + live capability descriptor. Cached in model_bindings.capabilities. */
  describeModel(modelId: string): Promise<ModelCapabilities>;

  /** The single inference entry point. ALWAYS streaming; non-streaming is a fold over this. */
  generate(req: GenerationRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;

  countTokens?(req: GenerationRequest): Promise<TokenCount>;
  embed?(req: EmbeddingRequest): Promise<EmbeddingResult>;
}
```

### 7.2 `ModelCapabilities` — provider differences as data

The runtime **reads** these. It never branches on provider identity.

```ts
interface ModelCapabilities {
  modelId: string;
  maxInputTokens: number;
  maxOutputTokens: number;

  tools: { supported: boolean; parallelCalls: boolean; forcedChoice: boolean;
           maxTools?: number; namePattern: RegExp; maxNameLength: number;
           jsonSchemaDialect: 'draft-07' | '2020-12'; strictMode: boolean };

  reasoning: { supported: boolean; mode: 'none' | 'budget' | 'adaptive' | 'always_on';
               effortLevels?: string[]; artifactsMustReplay: boolean;
               artifactsPortable: boolean };

  promptCache: { supported: boolean; strategy: 'explicit_breakpoints' | 'automatic' | 'none';
                 maxBreakpoints?: number; minPrefixTokens?: number };

  structuredOutput: { supported: boolean; mechanism: 'response_format' | 'output_config' | 'tool' };

  modalities: { imageInput: boolean; documentInput: boolean; audioInput: boolean };
  assistantPrefill: boolean;
  systemMessagePlacement: 'top_level' | 'first_message' | 'inline_allowed';
  streaming: boolean;
}
```

Runtime code reads like this, and only like this:

```ts
// GOOD — capability-driven
if (caps.promptCache.strategy === 'explicit_breakpoints') {
  plan.cacheBreakpoints = chooseBreakpoints(ctx, caps.promptCache.maxBreakpoints ?? 4);
}

// FORBIDDEN — fails CI lint rule `no-provider-branching`
if (provider === 'anthropic') { /* ... */ }
```

### 7.3 Canonical request and event types

```ts
interface GenerationRequest {
  system: SystemDirective[];            // ordered, cache-stable
  messages: CanonicalMessage[];
  tools: ToolDeclaration[];             // JSON Schema 2020-12, sorted deterministically
  toolChoice: 'auto' | 'none' | { name: string };
  maxOutputTokens: number;
  reasoning?: { effort?: 'low'|'medium'|'high'|'xhigh'|'max'; display?: 'omitted'|'summarized' };
  cacheHints?: { breakpointsAfter: number[] };
  structuredOutput?: { schema: JsonSchema };
  stopSequences?: string[];
  metadata: { runId: string; workspaceId: string; agentId: string };
}

type ProviderEvent =
  | { type: 'start';           messageId: string }
  | { type: 'text_delta';      text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_use_start';  id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }
  | { type: 'tool_use_end';    id: string; input: unknown }
  | { type: 'usage';           usage: Usage }        // incl. cacheRead / cacheWrite tokens
  | { type: 'finish';          reason: FinishReason; message: CanonicalMessage }
  | { type: 'error';           error: ProviderError }   // normalised + retryable flag
```

`FinishReason` is normalised across providers: `end_turn | tool_use | max_tokens | stop_sequence |
content_filter | refusal | error`. A provider-specific reason that has no canonical equivalent maps
to `error` with the raw value preserved in `ProviderError.providerRaw` — we never invent a
successful outcome we do not understand.

### 7.4 Provider-independent conversations (the critical design)

Messages are stored in a **canonical** form:

```ts
type ContentBlock =
  | { type: 'text';        text: string }
  | { type: 'image';       blobKey: string; mime: string }
  | { type: 'document';    blobKey: string; mime: string; title?: string }
  | { type: 'tool_use';    id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: ContentBlock[];
                           structured?: unknown; isError: boolean }
  | { type: 'reasoning';   summary?: string; redacted: boolean }
```

Alongside canonical content, each message may carry **opaque provider artifacts**:

```jsonc
// messages.provider_artifacts
{
  "anthropic:claude-opus-5": { "blocks": [ /* verbatim thinking blocks, signatures */ ] },
  "openai:<model>":          { "items":  [ /* verbatim reasoning items */ ] }
}
```

**Replay rule, enforced in the adapter (not the runtime):**

- Same `provider:model` as the artifact key → replay the artifact **verbatim and unmodified**.
- Different provider or model → **drop** the artifact; send only canonical `reasoning` summaries.

This rule is not optional. Anthropic's current models require thinking blocks to be echoed back
unchanged when continuing on the same model, silently ignore them when they come from a different
model, and newer models enforce an append-only history check that invalidates replayed thinking
blocks when earlier turns are edited. Encoding that as a per-adapter rule over an opaque,
model-keyed sidecar is what lets a single conversation move between Anthropic, OpenAI and Google
without corruption — and it is precisely what a naive "store the provider's JSON" design makes
impossible.

Two corollaries the runtime must honour:

- **History is append-only.** Compaction and context editing produce *new* messages (summaries,
  tombstones), never in-place edits to existing ones.
- **Artifacts are never sent to the LLM as text.** They are wire-format payloads, not content.

### 7.5 Adapter responsibilities

Each adapter (`packages/providers/{anthropic,openai,google}`) owns, and is the only place that
knows about:

| Responsibility | Example of what the adapter absorbs |
|---|---|
| Wire translation | canonical blocks ⇄ provider message shapes |
| Reasoning config | `effort` → `thinking: {type:'adaptive'}` + `output_config.effort`, or the equivalent knob elsewhere |
| Cache translation | `cacheHints.breakpointsAfter` → explicit `cache_control` markers, or a no-op where caching is automatic |
| Tool schema down-conversion | JSON Schema 2020-12 → the dialect and subset a given provider accepts; reject-or-degrade is an explicit, logged decision |
| Tool name normalisation | canonical `alias__tool` → provider-legal names within `namePattern` / `maxNameLength` |
| Artifact replay | §7.4 |
| Error normalisation | rate limits, overload, context-length, content filter, refusal → typed + `retryable` |
| Usage + cost | provider usage → canonical `Usage` incl. cache read/write; cost from `model_bindings` rates |
| Streaming | SSE/chunk protocol → `ProviderEvent` |

**Conformance test suite.** A single shared suite in `packages/providers/testkit` runs against every
adapter: golden canonical conversations, tool-call round-trips, parallel tool calls, streaming event
ordering, error taxonomy, schema down-conversion, artifact replay/drop. **A provider is not
"supported" until it passes the suite.** Adding a fourth provider must not require touching the
runtime — the suite is what proves that claim rather than asserting it.

### 7.6 Verified provider facts baked into adapters (as of 2026-09-15)

Recorded here so the adapters encode current reality rather than a stale prior:

- Current Anthropic models: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`,
  `claude-fable-5-1` (and the Opus 4.x line). Exact ID strings, never date-suffixed.
- Anthropic reasoning is `thinking: { type: 'adaptive' }`; `budget_tokens` is **rejected with 400**
  on current models. Depth is controlled by `output_config.effort` (`low` … `max`).
- Assistant **prefill is removed** on current Anthropic models (400). Output shaping uses
  structured outputs or system instructions. Our canonical format therefore has no prefill concept.
- Anthropic prompt caching is **prefix-match** with a small number of explicit breakpoints — which
  is why `ContextAssembler` must emit a byte-stable prefix (§8.3).
- Anthropic's own **MCP connector** (`mcp_servers` + `mcp_toolset` on the Messages API) exists, but
  we deliberately **do not use it**: it would move the MCP client into one vendor's inference API
  and forfeit tool-level permissions, audit, and provider independence. We are the MCP client.

---

## 8. Agent Runtime architecture

### 8.1 Shape

The runtime is a **deterministic, persisted, resumable step machine**, not a `while (true)` chat
loop. Every state transition is written to Postgres before the next begins. The process holds no
authoritative state, so a worker can die at any point and another picks the run up.

```
resolve → assemble → select → model_call → (tool_phase)? → persist → loop | suspend | finish
```

### 8.2 Phase 1 — Resolve

Load the pinned `agent_version`, the `model_binding` for the requested role, the principal and its
effective grants, and the `RunBudget`. Everything downstream reads from this immutable frame, so a
config change mid-run cannot alter behaviour.

```ts
interface RunBudget {
  maxSteps: number;          // default 24
  maxToolCalls: number;      // default 48
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxWallClockMs: number;    // default 15 min foreground, 2 h background
  maxCostUsd: number;
  maxSubagentDepth: number;  // default 2
  maxMrtrRounds: number;     // default 4 per tool call
}
```

Budgets are **enforced by the runtime**, independent of any provider-side budgeting feature. That
independence is the point.

### 8.3 Phase 2 — ContextAssembler (cache-stable by construction)

Emits in a fixed order, most-stable first, because prompt caching is prefix-match:

```
1. Tool declarations        (deterministically sorted; stable JSON serialisation)
2. System directives        (agent identity → workspace policy → safety rails)
3. Long-lived memory        (workspace/agent/user scope facts + instructions)
4. Retrieved documents      (RAG results for this turn)
5. Conversation summary     (compaction output, if any)
6. Recent message window    (verbatim canonical history)
7. Current turn input       (volatile — always after the last cache breakpoint)
```

Rules the assembler enforces:

- **No wall-clock timestamps, request IDs, or unsorted map iteration in the cacheable prefix.**
  These are the classic silent cache invalidators; they cost real money and are invisible in
  behaviour. The assembler has a lint mode that hashes the prefix across two consecutive builds of
  the same state and fails CI if they differ.
- Cache breakpoints are chosen from `caps.promptCache.maxBreakpoints`, placed at boundaries 1/2,
  3/4 and 5/6.
- **Compaction** triggers at a configurable fraction of `maxInputTokens`: summarise the oldest
  window with the `summarizer` model role, write a `conversation_summaries` row and a
  `compaction` run step, then continue. Never truncate silently; a compaction is always visible in
  the run log.

### 8.4 Phase 3 — CapabilitySelector

Presenting 400 tools to a model degrades quality and burns context. Selection is layered:

1. Start from the agent's `agent_capability_bindings` selection (`all` / `allow` / `deny`).
2. Drop capabilities the principal cannot use (`PermissionBroker` `deny` is applied *before* the
   model ever sees the tool — never offer a tool that will be refused).
3. Drop capabilities whose `definition_hash` is unapproved.
4. If the count exceeds `caps.tools.maxTools` or a configured budget, apply **progressive
   disclosure**: expose a stable core set plus a `capability_search` meta-tool that returns matching
   declarations on demand.
5. Normalise names to `alias__tool`, truncated and hash-suffixed to fit `caps.tools.maxNameLength`
   (§9.6).

### 8.5 Phase 4 — Model call

Streamed through `AgentProvider.generate`. Deltas are relayed to `run_events` live, so channels
stream tokens. On completion a `model_call` step row is written with usage and cost. Retries use
exponential backoff with jitter, bounded by the budget, and only for errors the adapter marked
`retryable`. On persistent provider failure, an optional **fallback model binding** for the same
role is tried once — provider-level HA, expressed purely in configuration.

### 8.6 Phase 5 — Tool phase

For each `tool_use` block, in parallel where the model emitted parallel calls:

```
ToolGateway.invoke():
  1. Resolve alias__tool → (binding, capability)
  2. PermissionBroker.decide()       → allow | ask | deny
       ask  → create approvals row, SUSPEND run as waiting_approval, return
       deny → synthesise an is_error tool_result explaining the denial (the model
              must learn it was denied, not silently get nothing)
  3. Validate arguments against input_schema with Ajv 2020-12  → on failure, is_error result
  4. Acquire per-binding concurrency slot + rate-limit token
  5. McpClientManager.callTool()
  6. Handle result:
       a. normal            → normalise content + structuredContent
       b. input_required    → MRTR loop (§9.5), bounded by maxMrtrRounds
       c. task handle       → register poll job, SUSPEND run as waiting_tool
  7. Cap result size; spill oversized payloads to blob store, pass a resource reference
  8. Write tool_invocations + audit_log
```

**All** tool results for one assistant turn are returned in a **single** tool message. Splitting
them across messages teaches models to stop making parallel calls — a subtle, permanent quality
regression.

### 8.7 Suspension and resumption

`waiting_approval`, `waiting_input` and `waiting_tool` are **first-class terminal-ish states**. A
suspended run holds no process, no socket, no memory. Resumption re-hydrates from
`runs` + `run_steps` and continues at the next `seq`. This is what makes human-in-the-loop,
long-running MCP tasks, and background execution the *same mechanism* rather than three.

### 8.8 Orchestration (sub-agents)

An agent may be granted a `spawn_subagent` platform capability (itself permission-gated). It creates
a child `run` with `parent_run_id` and `depth + 1`, bounded by `maxSubagentDepth`, with a budget
carved out of the parent's remaining budget. Child runs are ordinary runs — same runtime, same
persistence, same audit. There is no separate orchestration engine to maintain.

### 8.9 Background execution and scheduling

Foreground and background runs use **identical code**. The only differences are the trigger
(`trigger_type`), the budget profile, and the queue priority. A schedule fires → creates a run →
the same runtime executes it → results are delivered to the configured channel. Cron uses BullMQ
repeatable jobs; `schedule_runs` has a `U(schedule_id, fired_at)` constraint so a duplicate firing
after a restart is a no-op rather than a double charge.

---

## 9. MCP client architecture

`packages/mcp` is the only package that imports `@modelcontextprotocol/client`.

### 9.1 Components

```
McpServerRegistry      resolve binding → server definition + auth policy
McpConnectionFactory   build a transport for (binding, credentialScope)
McpClientManager       lifecycle, pooling, circuit breaking, health
CapabilityDiscovery    server/discover + tools|resources|prompts/list; ttlMs/cacheScope caching
CapabilityStore        persist mcp_capabilities, compute definition_hash, emit change events
ToolGateway            the ONLY path from runtime → MCP (permissions, validation, MRTR, audit)
McpOAuthClient         RFC 9728 discovery, RFC 8707 resource indicators, RFC 9207 issuer
                       validation, PKCE, CIMD client_id, token refresh + storage
McpTaskPoller          tasks/get polling → run resumption
McpSubscriptionManager subscriptions/listen opt-in (Phase 3)
```

### 9.2 Connection model under a stateless protocol

The 2026-07-28 spec removes protocol-level sessions, which **simplifies** this considerably:

- **Streamable HTTP:** no session to pool. We keep an HTTP agent with keep-alive, a per-scope token
  cache, a per-binding concurrency semaphore, and a circuit breaker. Any server replica can serve
  any request — which is exactly what the spec intended.
- **stdio:** a real OS process *is* state. We pool child processes per
  `(bindingId, credentialScopeKey)` with an idle TTL, a hard process cap per workspace, and
  restart-on-crash with backoff.

```ts
type ConnectionScopeKey =
  | { kind: 'workspace'; bindingId: string }
  | { kind: 'user';      bindingId: string; userId: string };   // per_user_auth = true
```

The scope key is part of every cache key, every pool key, and every token lookup. Mixing them is
the cross-tenant bug (risk R4), so it is structurally impossible rather than merely discouraged.

### 9.3 Dynamic capability discovery

```
1. Cache lookup keyed by (bindingId, scopeKey, kind), honouring ttlMs
   - cacheScope decides SHAREABILITY:
       shareable across users  → cache under the workspace scope key
       otherwise               → cache under the user scope key, NEVER shared
   - If cacheScope is absent or unrecognised → treat as NON-shareable. Fail closed.
2. On miss: server/discover, then tools/list, resources/list, prompts/list
   (version negotiation 'auto' per §2.3)
3. Normalise + compute definition_hash per capability
4. Diff against mcp_capabilities:
     new        → insert, status 'pending_approval'
     changed    → update hash, INVALIDATE approvals, emit capability_changed
     missing    → set removed_at (soft delete — history must stay explainable)
5. Emit workspace events so the UI reflects reality without a refresh
```

Discovery runs on: binding creation, manual refresh, `ttlMs` expiry, a `subscriptions/listen`
notification (Phase 3), and a nightly reconciliation job.

### 9.4 Invocation path

Already covered in §8.6. The invariant: **the runtime cannot reach an MCP server except through
`ToolGateway`.** There is no second path, no "internal" bypass, no platform-server exemption.

### 9.5 Multi-Round-Trip Requests (MRTR)

MRTR replaces deprecated server-initiated sampling and elicitation, and it is where a lot of
security lives.

```
callTool(args)
  └─ result.resultType === 'input_required'
       ├─ for each inputRequest, classify:
       │    'auto'     → policy can answer it (e.g. a known confirmation)
       │    'human'    → SUSPEND run (waiting_input), create an approval, ask via the channel
       │    'inference'→ the server wants the model to generate something
       ├─ POLICY GATE for 'inference': this is the old `sampling` capability wearing a new
       │    hat. It is DENIED by default. Enabling it per binding is an explicit opt-in that
       │    charges the workspace, runs under a hard sub-budget, and is fully audited. An MCP
       │    server must never get free, unbounded, unattributed access to our models.
       └─ retry the original call with { inputResponses, requestState } echoed verbatim
          (requestState is OPAQUE — never parsed, never modified, never logged in full)
  └─ bounded by budget.maxMrtrRounds
```

### 9.6 Capability namespacing

Collisions across servers are inevitable (three servers with a `search` tool).

```
canonical:  <bindingAlias>__<capabilityName>      e.g. gmail__send_message
```

`bindingAlias` is unique per workspace (`U(workspace_id, alias)`), so canonical names are unique by
construction. Providers impose stricter limits (commonly `^[a-zA-Z0-9_-]{1,64}$`), so the adapter
applies a deterministic transform — slugify → truncate → append a short hash of the full canonical
name — and keeps a per-request reverse map. Truncation is never allowed to create a collision;
the hash suffix guarantees that.

### 9.7 Hosting our own MCP servers

First-party capabilities (memory search, document retrieval, workspace admin, `spawn_subagent`) are
implemented as **real MCP servers** using `@modelcontextprotocol/server` + `@modelcontextprotocol/hono`,
not as runtime built-ins. This is a deliberate dogfooding constraint: if our own capabilities need a
back door, the abstraction is wrong and we will find out immediately rather than in month nine.

In-process transport is permitted for first-party servers as a latency optimisation, but it
implements the same client interface and passes through the same `ToolGateway`.

---

## 10. Channel architecture

```ts
interface ChannelAdapter {
  readonly type: ChannelType;
  readonly capabilities: {
    streaming: boolean; richText: 'markdown' | 'html' | 'plain';
    files: boolean; interactiveApproval: boolean; maxMessageLength: number;
  };
  parseInbound(raw: unknown, channel: Channel): Promise<InboundMessage | null>;
  deliver(event: OutboundEvent, target: DeliveryTarget): Promise<void>;
  verifySignature?(raw: unknown, headers: Headers): boolean;
}
```

- Channels **submit** inbound messages and **subscribe** to run events. They never call the runtime
  directly, never touch MCP, and never see credentials.
- Inbound webhook events are deduplicated via `channel_events.U(channel_id, external_event_id)`.
- Approval UX degrades by capability: web → modal; Telegram → inline keyboard; a channel without
  `interactiveApproval` → a link to the web console.
- Streaming degrades by capability: SSE token streaming on web; throttled message edits on Telegram
  (respecting its rate limits); a single final message elsewhere.

`packages/channels/telegram` uses the Telegram Bot API directly and is a **channel adapter, not an
agent capability**. If an agent needs to *send* Telegram messages as a tool, that is a separate
Telegram **MCP server** — a completely different thing from the channel. Conflating the two is
exactly the hard-coded-integration mistake this architecture exists to prevent.

---

## 11. Memory, documents and RAG

All behind ports in `packages/core`, so the storage engine is swappable:

```ts
interface MemoryStore    { search(q, scope, k): Promise<MemoryHit[]>; write(entry): Promise<void>;
                           supersede(id, by): Promise<void> }
interface VectorStore    { upsert(vectors): Promise<void>;
                           query(collectionId, embedding, k, filter): Promise<VectorHit[]> }
interface DocumentStore  { ingest(source): Promise<DocumentId>; status(id): Promise<Status> }
```

Phase-1 implementations are pgvector-backed. Swapping in a dedicated vector database later is an
adapter, not a migration of the domain.

- **Memory is bitemporal.** Entries are superseded, never updated. "Why did the agent believe that
  in March?" must be answerable.
- **Memory writes are explicit run steps** (`memory_write`), visible in the run log and subject to
  policy. Agents do not mutate long-term memory invisibly.
- **Retrieval is hybrid**: HNSW vector search + Postgres full-text (`tsv`), fused with Reciprocal
  Rank Fusion, then optionally reranked by the `cheap` model role.
- **Ingestion is a resumable pipeline**: fetch → extract → chunk → embed → index, with per-stage
  checkpoints, so a failure at embedding does not re-download and re-parse a 300-page PDF.
- **Documents can originate from MCP resources** (`source_type = 'mcp_resource'`), which is how RAG
  and MCP compose instead of competing.

---

## 12. Folder structure

```
salvations/
├── ARCHITECTURE.md
├── TODO.md
├── README.md
├── package.json                     # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .dependency-cruiser.cjs          # enforces §4.2 dependency rule
├── docker-compose.yml               # postgres+pgvector, redis, minio (dev)
│
├── apps/
│   ├── api/                         # Hono HTTP API — composition root
│   │   └── src/{routes,middleware,channels,container.ts,server.ts}
│   │        routes/: auth, workspaces, agents, mcp, credentials, conversations,
│   │                 runs, approvals, documents, schedules, channels, admin, health
│   ├── worker/                      # BullMQ consumers — composition root
│   │   └── src/{processors,schedulers,container.ts,worker.ts}
│   │        processors/: run.processor, ingest.processor, discovery.processor,
│   │                     mcp-task.processor, outbox.processor, embedding.processor
│   └── web/                         # Next.js 16 console (the web CHANNEL)
│       └── src/app/(auth)|(app)/{chat,agents,mcp,credentials,documents,
│                                  schedules,runs,settings}
│
├── packages/
│   ├── core/                        # PURE. entities + ports + policy. No I/O.
│   │   └── src/{entities,ports,policy,errors,ids}
│   │        ports/: agent-provider, mcp-client, memory-store, vector-store,
│   │                blob-store, key-provider, channel-adapter, event-bus,
│   │                clock, job-queue
│   │        policy/: permission-broker, budget, redaction, capability-selection
│   │
│   ├── runtime/                     # AGENT RUNTIME. Depends on core PORTS only.
│   │   └── src/{agent-runtime,resolver,context-assembler,capability-selector,
│   │            model-call,tool-phase,compaction,suspension,orchestration,budget-meter}
│   │
│   ├── providers/                   # AgentProvider adapters
│   │   ├── anthropic/  openai/  google/
│   │   ├── registry/                # provider_type → adapter factory
│   │   └── testkit/                 # SHARED conformance suite (§7.5)
│   │
│   ├── mcp/                         # MCP client layer (§9)
│   │   └── src/{registry,connection-factory,client-manager,discovery,
│   │            capability-store,tool-gateway,oauth,task-poller,
│   │            subscriptions,transports/{streamable-http,stdio,in-process},
│   │            namespacing,schema-validator}
│   │
│   ├── db/                          # Drizzle schema, migrations, repositories, RLS
│   │   └── src/{schema,migrations,repositories,rls,seed}
│   │
│   ├── memory/                      # MemoryStore + VectorStore + retrieval
│   ├── documents/                   # ingestion pipeline, chunking, extractors
│   ├── channels/                    # web (SSE), telegram, api; shared adapter contract
│   ├── crypto/                      # envelope encryption, KeyProvider impls, redaction
│   ├── contracts/                   # Zod API contracts shared by api + web
│   └── observability/               # OTel setup, logger, metrics, audit writer
│
├── mcp-servers/                     # OUR OWN first-party MCP servers (§9.7)
│   ├── memory/  documents/  workspace-admin/  orchestration/
│
├── docs/{adr,runbooks,api}          # ADRs record every decision in this file
└── tools/{scripts,eslint-rules}     # incl. the `no-provider-branching` lint rule
```

---

## 13. Architectural risks

Ordered by expected damage. Each has an owner phase in TODO.md.

| # | Risk | Why it is real | Mitigation |
|---|---|---|---|
| **R1** | **Prompt injection via MCP tool results** — a tool returns text that instructs the model to call another tool | This is the central security problem of agent platforms. Tool output is attacker-controlled data from a third-party server | Tool results are structurally marked as untrusted data in context; destructive capabilities require `ask` regardless of what any text says; `trust_tier` gates which capabilities an untrusted server's output may chain into; per-run tool-call caps; full audit of every chain |
| **R2** | **Tool-definition rug pull** — a server changes a tool's description/schema after approval | MCP definitions are fetched at runtime from code we do not control. Description text enters the model's context and is therefore an injection surface | `definition_hash` on every capability; **any change invalidates approval** and requires explicit re-approval; diffs shown in the UI; `trust_tier` controls whether auto-approval is even offered |
| **R3** | **Server-requested inference via MRTR** becomes free, unbounded model access | MRTR replaces `sampling`; a malicious server can ask the client to run inference | Denied by default; per-binding explicit opt-in; hard sub-budget; charged to the workspace; audited; bounded by `maxMrtrRounds` |
| **R4** | **Cross-tenant leakage through the discovery cache** | `cacheScope` says whether a `tools/list` may be shared across users. Getting it wrong leaks one tenant's tool surface into another's | `ConnectionScopeKey` is part of every cache key by type; unknown/absent `cacheScope` ⇒ treated as non-shareable (fail closed); an integration test asserts no cross-scope reuse |
| **R5** | **Provider abstraction leakage** — `if (provider === ...)` creeps into the runtime | This is how every "provider-agnostic" system dies. It happens one urgent fix at a time | `no-provider-branching` ESLint rule; `dependency-cruiser` forbids runtime → provider packages; the conformance suite (§7.5); **three adapters from Phase 1** so leaks surface immediately, not at adapter #2 |
| **R6** | **stdio MCP servers are arbitrary code execution inside our infrastructure** | stdio spawns a process with our filesystem and network. Traffic is invisible to network-layer controls, and the launching runtime becomes part of the trust chain | In the hosted tier, stdio is restricted to first-party/verified servers only; every stdio process runs in a container sandbox with a read-only rootfs, no ambient credentials (env injected per invocation), egress allowlist, and CPU/memory/PID caps. Third-party servers must use Streamable HTTP |
| **R7** | **Runaway cost / infinite tool loops** | Agents loop. Cheaply, then expensively | `RunBudget` enforced by the runtime (not the provider); per-workspace daily cost caps; loop detection on repeated identical tool calls; kill switch per agent and per workspace |
| **R8** | **Context window exhaustion in long conversations** | Multi-day conversations exceed any window | Compaction with explicit `conversation_summaries`; hybrid retrieval over history rather than replay; per-message token estimates maintained incrementally |
| **R9** | **Prompt-cache invalidation going unnoticed** | A timestamp in a system prompt silently multiplies cost with zero behavioural signal | Cache-stable assembler with a CI prefix-stability test; `cache_read_tokens` tracked in `usage_records` and alerted on when the hit rate drops |
| **R10** | **MCP spec churn** | `2026-07-28` was a major rewrite; more will come. A 12-month deprecation policy now exists but does not stop change | All protocol contact confined to `packages/mcp`; SDK version negotiation `auto`; negotiated version recorded per binding; protocol upgrades are a single-package change |
| **R11** | **OAuth token custody across many servers** | Dozens of bindings × per-user auth = a lot of refresh tokens | RFC 8707 resource indicators scope every token to one server; per-credential envelope encryption; short-lived access tokens; revocation cascades from `oauth_connections` |
| **R12** | **Embedding dimension lock-in** | Changing embedding models invalidates an entire index | Per-collection `embedding_dim`, sidecar tables per dimension, shadow-collection re-embedding with atomic swap (§5.3) |
| **R13** | **Noisy-neighbour workspaces** | One workspace's 10k-document ingest starves everyone | Per-workspace BullMQ rate limits and queue groups; separate queues for interactive vs. batch; per-binding concurrency semaphores |
| **R14** | **Approval fatigue** | If everything asks, users click "allow all" and the model is worthless | Risk-tiered defaults driven by `trust_tier` + MCP annotations as a *floor*; scoped remembered decisions ("allow this tool with these argument constraints for 24h"); read-only tools default to `allow` for verified servers |

---

## 14. Conflicts with the current official MCP specification

Common designs that would be **wrong** against `2026-07-28`, listed because they are the defaults
most teams would reach for:

1. **Modelling an MCP connection as a long-lived stateful session.** `initialize`/`initialized` and
   `Mcp-Session-Id` are removed. Any pool keyed on a session ID is building on a deleted concept.
   → We treat remote MCP as stateless request/response.
2. **Building human-in-the-loop on server-initiated `elicitation`, or server inference on
   `sampling`.** Both are deprecated in favour of MRTR. → We implement MRTR only.
3. **Relying on `roots` or `logging`.** Deprecated (12-month window). → Not used. Filesystem scoping
   is expressed through server configuration and sandbox policy instead.
4. **Implementing the HTTP+SSE transport.** Officially deprecated with a 12-month off-ramp.
   → Streamable HTTP and stdio only.
5. **Using Dynamic Client Registration as the primary OAuth onboarding path.** Formally deprecated
   in favour of CIMD. → CIMD primary, DCR fallback.
6. **Skipping RFC 8707 resource indicators or RFC 9207 issuer validation.** Both are now required
   client behaviour and are the defence against token-reuse and AS-mix-up attacks. → Enforced.
7. **Stripping or rewriting `Mcp-Method` / `Mcp-Name` headers in a proxy.** Servers reject requests
   where headers and body disagree. → Our egress path preserves them verbatim.
8. **Assuming `structuredContent` is always a JSON object, or that tool schemas are draft-07.**
   2020-12 with unrestricted `outputSchema`, and `structuredContent` may be any JSON value.
   → Ajv 2020-12; result handling accepts any JSON value.
9. **Ignoring `ttlMs` / `cacheScope`.** Not just a performance hint — `cacheScope` is a
   **tenancy-safety** signal. → Honoured, and fail-closed when absent (R4).
10. **Building on the 2025-11-25 experimental Tasks API.** Explicitly breaking. → Poll-based
    `tasks/get` / `tasks/update` / `tasks/cancel`.
11. **Treating our channels (Telegram/web) as MCP.** MCP is the capability layer between host and
    tools; it is not a UI transport. Conflating them is an architectural category error.
12. **Using a provider's built-in MCP connector** (e.g. Anthropic's `mcp_toolset`) as the MCP
    client. It works, but it relocates the capability layer inside one vendor's inference API and
    forfeits tool-level permissions, audit and provider independence. → We are the MCP client.

---

## 15. Phase 1 implementation plan

**Objective:** one **vertical slice** that proves every abstraction with real load-bearing weight.
The test of Phase 1 is not feature count — it is that the same conversation can be driven by three
different providers and reach a real third-party MCP server through a real permission gate.

### 15.1 In scope

| Area | Phase 1 scope |
|---|---|
| Monorepo | pnpm + Turbo, strict TS, `dependency-cruiser` + `no-provider-branching` enforced in CI from commit one |
| Database | Full §5.2 schema, Drizzle migrations, **RLS enabled on every tenant table**, seed script |
| Auth | Better Auth (email/password + one OAuth provider), workspaces, members, roles, invitations, API keys |
| Crypto | Envelope encryption + `LocalFileKeyProvider`; `KmsKeyProvider` interface stubbed |
| Providers | **Three** adapters — Anthropic, OpenAI, Google — all passing the conformance suite |
| MCP | Streamable HTTP transport, `auto` version negotiation, `server/discover`, tools discovery with `ttlMs`/`cacheScope`, `definition_hash`, OAuth with CIMD + RFC 8707/9728/9207, `ToolGateway`, MRTR for human input (inference **denied**) |
| Permissions | `PermissionBroker` with allow/ask/deny, capability approval flow, `ask` → suspend → approve → resume |
| Runtime | Full step machine: resolve → assemble → select → model_call → tool_phase → persist, with budgets, suspension/resumption, streaming, compaction |
| Memory | Conversation history + compaction summaries only (no semantic memory) |
| Channels | **Web only** — SSE streaming, approval modal, run timeline |
| Background | BullMQ + transactional outbox; background runs work; **no cron yet** |
| Observability | OTel traces across run → model call → tool call; structured logs; `audit_log`; `usage_records` + cost |

### 15.2 Explicitly out of scope for Phase 1

Documents/RAG · semantic memory · Telegram · scheduled tasks · stdio transport · sub-agents ·
MCP resources & prompts · `subscriptions/listen` · Tasks extension · first-party MCP servers ·
public API · billing.

Each has a home in TODO.md. Pulling any of them forward is what turns a vertical slice into a
horizontal mess.

### 15.3 Definition of done

Phase 1 is complete when **all** of these hold:

1. A user signs up, creates a workspace, invites a colleague, and both see the same agent.
2. The workspace configures **three** provider configs and three model bindings.
3. The workspace installs a **real third-party MCP server** over Streamable HTTP with OAuth,
   completes the CIMD-based flow, and sees discovered tools pending approval.
4. An admin approves specific tools and writes permissions: one `allow`, one `ask`, one `deny`.
5. A conversation with the agent triggers all three paths — the `ask` suspends the run, the
   approval resumes it, the `deny` returns an explanatory error to the model.
6. **The same conversation is continued after switching the model binding from Anthropic to OpenAI
   to Google. History replays correctly; reasoning artifacts are replayed on same-model
   continuation and dropped on cross-model continuation.** *(This is the acceptance test for the
   entire vendor-independence claim.)*
7. A tool definition is changed server-side; the next discovery invalidates approval and blocks the
   capability until re-approved.
8. A run exceeding its budget terminates cleanly with a partial result and an accurate cost record.
9. A worker is killed mid-run; another worker resumes it without duplicate tool side effects.
10. Restricted DB role + RLS: a deliberately unscoped query in a test returns **zero rows**.
11. `grep -rE "gmail|telegram|notion|github|slack" packages/runtime packages/core` returns
    **nothing**.
12. `grep -rE "anthropic|openai|gemini|google" packages/runtime packages/core` returns **nothing**.

Criteria 11 and 12 are run in CI on every commit. They are the architecture, expressed as a test.

---

## Sources

- [The 2026-07-28 Specification — Model Context Protocol Blog][mcp-spec]
- [The 2026-07-28 MCP Specification Release Candidate — Model Context Protocol Blog][mcp-rc]
- [MCP TypeScript SDK V2 — Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)
- [MCP TypeScript SDK — GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [`@modelcontextprotocol/client` — npm](https://www.npmjs.com/package/@modelcontextprotocol/client)
- [MCP Security Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html)
- [Security Best Practices — Model Context Protocol](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [The biggest MCP spec update ships July 28 — WorkOS](https://workos.com/blog/mcp-2026-spec-agent-authentication)
- [Migrating MCP auth from DCR to CIMD](https://mcporbit.com/blog/migrate-mcp-auth-dcr-to-cimd)
- [The 2026-07-28 MCP Specification: A Stateless, Extensible Future — MCP Servers](https://blog.mcpservers.org/posts/mcp-spec-2026-07-28)

[mcp-spec]: https://blog.modelcontextprotocol.io/posts/2026-07-28/
[mcp-rc]: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
