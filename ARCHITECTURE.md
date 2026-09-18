# HIVE — MCP-Native Agent Host Platform

**Status:** Proposed architecture, revision 2 — **awaiting final approval. No application code
has been written.**
**Last verified against external sources:** 2026-09-15

> **Revision 2 changes:** MongoDB Atlas replaces PostgreSQL as the primary database (document-native
> model, official driver, no ODM). Vercel is the initial deployment target. The execution model is
> restructured around sliced, resumable runs so background work can move to a separate worker
> service later without touching the runtime. RAG moves to Phase 2 on Atlas Vector Search.

## Companion documents

| Document | Contents |
|---|---|
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | MongoDB collections, document shapes, ERD, indexes, modelling rationale |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel topology, execution model, worker-extraction path |
| [docs/SECURITY.md](docs/SECURITY.md) | AuthN/AuthZ, tenant isolation, credentials, MCP threat model, risk register |
| [docs/PROVIDER-ABSTRACTION.md](docs/PROVIDER-ABSTRACTION.md) | `AgentProvider` port, capabilities, canonical conversations, conformance suite |
| [docs/MCP-CLIENT.md](docs/MCP-CLIENT.md) | MCP spec alignment, SDK V2, discovery, `ToolGateway`, MRTR |
| [TODO.md](TODO.md) | Phase-by-phase implementation roadmap |

---

## 0. Repository state

Inspected before any design work:

```
/home/user/salvations
├── .git/    (branch claude/epic-gates-clsnom — one commit: the revision-1 architecture)
├── ARCHITECTURE.md
├── TODO.md
└── docs/
```

**No application code, package manifest, schema, or CI configuration exists.** This is greenfield.

---

## 1. Product thesis and the non-negotiable principle

HIVE is an **MCP-native agent host / orchestration platform**. It is explicitly *not* a
chatbot with integrations bolted on.

The layering is the product:

| Layer | Responsibility | Replaceable? |
|---|---|---|
| **Agent** | Reasoning engine only. Chooses the next action. | Yes — any provider, any model |
| **MCP** | The *only* standardized capability layer | It is the contract |
| **Agent Host** | Context, memory, permissions, execution, orchestration, budgets, audit | This is the product |
| **Channels** | User interfaces (web now; Telegram, email, API later) | Yes — pluggable |
| **MCP Servers** | Extensible capability providers, first- and third-party | Yes — installable |

### 1.1 The five rules that fall out of this

1. **The Agent Runtime never names an integration.** No `if (tool === 'gmail')`, no Notion client,
   no Telegram import anywhere in `packages/runtime` or `packages/core`. Integrations reach the
   runtime *only* as discovered MCP capabilities.
2. **The Agent Runtime never names a provider.** Provider differences are *data*
   (`ModelCapabilities`) that the runtime reads, and *behaviour* inside adapters it cannot see.
3. **Conversations are stored canonically, never in provider wire format.** Provider-specific
   reasoning state lives in an opaque, model-keyed sidecar with explicit replay rules.
4. **Every capability invocation passes a permission decision and an audit record.** No exceptions,
   including for platform-owned servers.
5. **The runtime never knows where it is running.** No `if (isVercel)`. Environment differences live
   in executor and queue adapters at the composition root.

Rules 1, 2 and 5 are enforced by CI gates, not by review discipline (§7).

### 1.2 Explicit non-goals for v1

Not a general workflow/DAG engine · not an MCP marketplace with third-party billing · not a
fine-tuning platform · not multi-region active/active.

---

## 2. Technology stack

| Concern | Choice | Version (verified 2026-09-15) | Rationale |
|---|---|---|---|
| Language / runtime | TypeScript (strict), Node 22 LTS | — | MCP TypeScript SDK is **Tier 1** for the 2026-07-28 spec; one type system across app, worker and future MCP servers |
| Monorepo | pnpm workspaces + Turborepo | — | Package boundaries *are* the architecture |
| App + API | **Next.js 16 (App Router)** on **Vercel** | 16.3.x | One deployable in Phase 1: UI, API routes, SSE, and the run executor |
| Database | **MongoDB Atlas** (replica set, MongoDB 8.1+) | — | Primary store. 8.1+ for `$rankFusion` in Phase 2 |
| Driver | **Official `mongodb` Node driver — no ODM** | 7.6.x | See `DATA-MODEL.md` §0.2 |
| Auth | Better Auth + `@better-auth/mongo-adapter` | 1.7.x | Self-hosted, owns its collections in *our* Atlas cluster |
| Validation | Zod 4 (our contracts) + **Ajv 2020** (untrusted MCP schemas) | zod 4.6.x | MCP tool schemas are JSON Schema **2020-12** |
| MCP | `@modelcontextprotocol/client` **V2** | 2.0.0 | Official SDK; Streamable HTTP |
| Vector search | **Atlas Vector Search** (`$vectorSearch`, `$rankFusion`) | Phase 2 | Native hybrid search; no separate vector DB |
| Blob storage | `BlobStore` port → Vercel Blob | — | S3-compatible adapter ready, unused |
| Secrets | Envelope encryption, AES-256-GCM, `KeyProvider` port | — | `EnvKeyProvider` on Vercel; KMS/Vault stubbed |
| Queue | **MongoDB `runs` collection (lease-based)** | Phase 1 | **No Redis in Phase 1.** Redis/BullMQ becomes a *notification* layer in Phase 4 |
| Observability | OpenTelemetry + structured JSON logs | — | Vendor-neutral by construction |

Provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`) are dependencies of **adapter
packages only** and are never imported elsewhere.

**Deliberately rejected:** Mongoose/ODM (`DATA-MODEL.md` §0.2) · Vercel AI SDK as the core provider
abstraction (`PROVIDER-ABSTRACTION.md` §9) · provider-hosted MCP connectors (`MCP-CLIENT.md` §1) ·
Redis in Phase 1 (`DEPLOYMENT.md` §3.2).

---

## 3. System architecture

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │                      VERCEL — Next.js 16                             │
  │                                                                      │
  │  UI (RSC)   │  /api/auth/*   /api/workspaces/*   /api/agents/*       │
  │             │  /api/mcp/*    /api/conversations/*                    │
  │  ───────────┼──────────────────────────────────────────────────────  │
  │             │  /api/runs/:id/events   ← SSE, tails runEvents         │
  │             │  /api/internal/execute  ← RUN EXECUTOR (HMAC)          │
  │             │  /api/internal/sweep    ← stalled-lease reclaim        │
  └──────┬──────┴───────────────────────────────┬───────────────────────┘
         │ composition root injects adapters    │
  ┌──────▼───────────────────────────────────┐  │
  │      packages/runtime — AGENT RUNTIME    │  │
  │  Resolver → ContextAssembler →           │  │
  │  CapabilitySelector → ModelCall →        │  │
  │  ToolPhase → Persist → step | suspend    │  │
  │        (exposes stepOnce(); the          │  │
  │         EXECUTOR owns the loop)          │  │
  └───┬──────────────┬───────────────┬───────┘  │
      │              │               │          │
┌─────▼──────┐ ┌─────▼────────┐ ┌────▼───────┐  │
│AgentProvider│ │ ToolGateway  │ │ Repositories│ │
│   (port)    │ │ + Permission │ │   (ports)   │ │
└─────┬───────┘ │   Broker     │ └────┬────────┘ │
      │         └─────┬────────┘      │          │
┌─────▼────────────┐  │        ┌──────▼──────────▼──────────┐
│ anthropic /      │  │        │      MONGODB ATLAS         │
│ openai / google  │  │        │  state of record           │
│    adapters      │  │        │  runs = the work queue     │
└──────────────────┘  │        │  runEvents = change stream │
                      │        └────────────────────────────┘
          ┌───────────▼──────────┐
          │  packages/mcp        │
          │  MCP Client (SDK V2) │
          └───────────┬──────────┘
                      │ Streamable HTTP
          ┌───────────▼──────────────────────┐
          │  MCP SERVERS (third-party)       │
          └──────────────────────────────────┘
```

### 3.1 Dependency rule (CI-enforced)

```
core  ←  runtime  ←  apps
  ↑         ↑
  └── mcp, providers, db, channels, crypto, contracts, observability
```

- `packages/core` — entities, ports, pure policy. **Zero** runtime dependencies beyond `zod`.
  Cannot import `mongodb`, HTTP, or any SDK.
- `packages/runtime` — depends on `core` **ports only**. Never imports `packages/providers/*`,
  `packages/mcp` concretes, `packages/db`, or anything from `@vercel/*`.
- `apps/web` — the **only** composition root in Phase 1. The only place concrete adapters are bound
  to ports, and the only place `@vercel/*` may be imported.

Enforced by `dependency-cruiser` + `eslint-plugin-boundaries` in CI. **Architecture that is not
enforced is a wish.**

---

## 4. Execution model — Vercel now, worker later

Full detail in `DEPLOYMENT.md`. The essential shape:

**The verified constraint:** Vercel functions default to 300 s (800 s GA, 1800 s beta), and
`waitUntil` **does not outlive `maxDuration`**. There is no fire-and-forget on Vercel.

**The response:** the runtime exposes `stepOnce()`; an **executor** owns the loop.

```ts
interface RunExecutor { execute(runId: RunId, deadline: Deadline): Promise<ExecOutcome> }

type ExecOutcome =
  | { kind: 'finished';  status: 'succeeded' | 'failed' | 'cancelled' }
  | { kind: 'suspended'; reason: 'approval' | 'input' | 'tool' }
  | { kind: 'yielded';   resumeAt: Date };     // slice exhausted; run returns to `queued`
```

| Executor | Environment | Loop |
|---|---|---|
| `SlicedExecutor` | Vercel function | until deadline − `RESERVE_MS`, then persist, release lease, re-queue, trigger continuation |
| `ContinuousExecutor` | Worker container (Phase 4) | until completion or suspension |

Both wrap the **identical** `stepOnce`. A slice never ends mid-step.

**The queue is MongoDB.** `runs` doubles as the work queue via an atomic lease claim
(`findOneAndUpdate`), with every subsequent write guarded by `lease.token` so a stolen-lease
executor cannot write. This is what prevents duplicate tool side effects, and it is identical in
both topologies.

**Why the worker migration is not a rewrite (requirement 7):**

| Concern | Phase 1 | Phase 4 worker | Change |
|---|---|---|---|
| Run state | MongoDB | MongoDB | none |
| Claim | lease `findOneAndUpdate` | same, or BullMQ | swap `RunQueue` adapter |
| Loop | `SlicedExecutor` | `ContinuousExecutor` | swap adapter at composition root |
| Step logic | `AgentRuntime.stepOnce` | same | **none** |
| Event delivery | change stream → SSE | change stream or Redis → SSE | swap `EventBus` adapter |
| Frontend | `/api/runs/:id/events` | identical | **none** |

**Redis, when it arrives, is a notification channel — not a state store.** A lost message costs
latency (the sweeper finds the run); never correctness.

**Streaming is decoupled from execution** from day one: the browser tails `runEvents` via a change
stream with a cursor, so it never holds a connection to the executing function. That is what makes
the frontend row above true.

---

## 5. Key interfaces

```ts
// ─── packages/core/src/ports ────────────────────────────────────────────

interface AgentProvider {                         // PROVIDER-ABSTRACTION.md
  readonly providerType: ProviderType;
  describeModel(modelId: string): Promise<ModelCapabilities>;
  generate(req: GenerationRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  countTokens?(req: GenerationRequest): Promise<TokenCount>;
  embed?(req: EmbeddingRequest): Promise<EmbeddingResult>;          // Phase 2
}

interface ToolGateway {                           // MCP-CLIENT.md §7
  listAvailable(ctx: RunContext): Promise<ToolDeclaration[]>;
  invoke(canonicalName: string, args: unknown, ctx: RunContext): Promise<ToolOutcome>;
}

interface PermissionBroker {                      // SECURITY.md §3.3
  decide(input: PermissionInput): Promise<PermissionDecision>;      // allow | ask | deny
}

interface RunQueue {                              // DEPLOYMENT.md §3.2
  enqueue(run: RunSubmission): Promise<RunId>;
  claim(owner: string, leaseMs: number): Promise<ClaimedRun | null>;
  heartbeat(runId: RunId, token: string): Promise<void>;
  release(runId: RunId, token: string, next: ReleaseIntent): Promise<void>;
}

interface RunExecutor { execute(runId: RunId, deadline: Deadline): Promise<ExecOutcome> }

interface RunEventBus {
  publish(runId: RunId, event: RunEvent): Promise<void>;
  subscribe(runId: RunId, afterSeq: number): AsyncIterable<RunEvent>;
}

interface BackgroundTrigger { trigger(runId: RunId): Promise<void> }   // the ONLY Vercel-aware port

interface ScopedDb {                              // DATA-MODEL.md §0.3
  readonly workspaceId: WorkspaceId;
  collection<K extends TenantCollection>(name: K): ScopedCollection<DocOf<K>>;
}

interface KeyProvider  { wrap(dek): Promise<Wrapped>; unwrap(w): Promise<Dek>; version(): number }
interface BlobStore    { put(key, data, mime): Promise<void>; get(key): Promise<ReadableStream> }
interface ChannelAdapter { /* parseInbound · deliver · capabilities */ }   // Phase 4

// ─── packages/runtime ───────────────────────────────────────────────────

class AgentRuntime {
  stepOnce(ctx: RunContext): Promise<StepOutcome>;   // ONE model call OR ONE tool phase
}
```

---

## 6. Folder structure

```
salvations/
├── ARCHITECTURE.md · TODO.md · README.md
├── package.json · pnpm-workspace.yaml · turbo.json · tsconfig.base.json
├── .dependency-cruiser.cjs          # enforces §3.1
├── .env.example · .gitignore
├── docker-compose.yml               # local mongo replica set (change streams need one)
│
├── apps/
│   └── web/                         # Next.js 16 — UI + API + executor. COMPOSITION ROOT.
│       ├── Dockerfile               # built in CI from Phase 1 (container-friendliness)
│       └── src/
│           ├── app/(auth)/ (app)/{chat,agents,mcp,credentials,providers,runs,settings}
│           ├── app/api/{auth,workspaces,agents,mcp,conversations,runs,credentials,health}
│           ├── app/api/internal/{execute,sweep}      # ONLY place @vercel/* may be imported
│           └── container.ts                          # binds concrete adapters to ports
│
├── packages/
│   ├── core/                        # PURE. entities + ports + policy. zod only.
│   │   └── src/{entities,ports,policy,errors,ids}
│   ├── runtime/                     # AGENT RUNTIME. core ports only.
│   │   └── src/{agent-runtime,resolver,context-assembler,capability-selector,
│   │            model-call,tool-phase,compaction,budget-meter,executors}
│   ├── providers/
│   │   ├── anthropic/ · openai/ · google/
│   │   ├── registry/                # providerType → adapter factory
│   │   └── testkit/                 # SHARED conformance suite — written FIRST
│   ├── mcp/
│   │   └── src/{registry,connection-factory,client-manager,discovery,capability-store,
│   │            tool-gateway,oauth,namespacing,schema-validator,transports/streamable-http}
│   ├── db/                          # THE ONLY PLACE `mongodb` MAY BE IMPORTED
│   │   └── src/{client,scoped,guard,collections,mappers,repositories,migrations,indexes}
│   ├── crypto/                      # envelope encryption, KeyProvider impls, redaction
│   ├── channels/web/                # SSE channel adapter
│   ├── contracts/                   # Zod contracts shared by API + UI
│   └── observability/               # OTel, logger, metrics, audit writer
│
├── apps/worker/                     # PLACEHOLDER (Phase 4) — Dockerfile + entrypoint only
├── mcp-servers/                     # PLACEHOLDER (Phase 5)
├── docs/{DATA-MODEL,DEPLOYMENT,SECURITY,PROVIDER-ABSTRACTION,MCP-CLIENT}.md · docs/adr/
└── tools/{scripts,eslint-rules}     # incl. `no-provider-branching`
```

---

## 7. CI-enforced standing invariants

These are the architecture, expressed as tests. All run on every commit.

| # | Invariant | Check |
|---|---|---|
| I1 | Runtime names no integration | `grep -rE "gmail\|telegram\|notion\|github\|slack" packages/runtime packages/core` → empty |
| I2 | Runtime names no provider | `grep -rE "anthropic\|openai\|gemini\|google" packages/runtime packages/core` → empty |
| I3 | Runtime names no platform | `grep -rE "vercel\|@vercel" packages/runtime packages/core packages/mcp packages/db` → empty |
| I4 | `mongodb` imported only in `packages/db` | dependency-cruiser |
| I5 | `packages/core` imports only `zod` | dependency-cruiser |
| I6 | Runtime never imports providers/mcp concretes/db | dependency-cruiser |
| I7 | Every adapter passes the conformance suite | `packages/providers/testkit` |
| I8 | No unscoped tenant query | command-monitoring guard throws in CI (`SECURITY.md` §4.2 C2) |
| I9 | Cache-stable prompt prefix | two builds of identical state produce byte-identical prefixes |
| I10 | No secret reachable from run/step/event/audit/log | redaction test corpus |

---

## 8. Risks

Full register with severities and mitigations in [docs/SECURITY.md](docs/SECURITY.md) §7. The five
that most shape the design:

- **R4 — Cross-tenant leakage without row-level security.** MongoDB has no RLS. This is a genuine
  reduction in structural guarantee versus the revision-1 PostgreSQL design, stated plainly rather
  than papered over, and compensated by seven controls — chiefly the **driver command-monitoring
  tenancy guard**, which catches an unscoped query regardless of the code path that produced it.
- **R1 — Prompt injection via tool results.** The central security problem of any agent host. Tool
  output is attacker-controlled data from third-party code.
- **R2 — Tool-definition rug pull.** Solved structurally: `definitionHash` and
  `approval.definitionHash` live in the *same document* and update atomically, so approval
  self-invalidates with no race window.
- **R5 — Provider abstraction leakage.** How every "provider-agnostic" system dies, one urgent fix
  at a time. Countered with lint rules, boundary rules, a shared conformance suite, and **three
  adapters in Phase 1** so leaks surface immediately rather than at adapter #4.
- **R12 — Duplicate run execution on serverless.** Atomic lease claim plus `lease.token`-guarded
  writes.

---

## 9. Conflicts with the current MCP specification

Designs that would be **wrong** against `2026-07-28` — listed because they are the defaults most
teams reach for. Full detail in [docs/MCP-CLIENT.md](docs/MCP-CLIENT.md) §2.

1. Modelling an MCP connection as a long-lived stateful session — `initialize` and
   `Mcp-Session-Id` are **removed**.
2. Building human-in-the-loop on server-initiated `elicitation`, or server inference on `sampling`
   — both deprecated in favour of **MRTR**.
3. Relying on `roots` or `logging` — deprecated.
4. Implementing the HTTP+SSE transport — officially deprecated with a 12-month off-ramp.
5. Using **DCR** as the primary OAuth onboarding path — deprecated in favour of **CIMD**.
6. Skipping **RFC 8707** resource indicators or **RFC 9207** issuer validation — both are now
   required client behaviour.
7. Stripping or rewriting `Mcp-Method` / `Mcp-Name` headers in a proxy — servers reject
   header/body disagreement.
8. Assuming `structuredContent` is an object or that tool schemas are draft-07 — it is **2020-12**,
   and `structuredContent` may be any JSON value.
9. Ignoring `ttlMs` / `cacheScope` — `cacheScope` is a **tenancy-safety** signal, not a perf hint.
10. Building on the 2025-11-25 experimental Tasks API — explicitly breaking.
11. Treating channels (web/Telegram) as MCP — a category error.
12. Using a provider-hosted MCP connector as the client — forfeits permissions, audit and provider
    independence.

---

## 10. Phase 1 — the vertical slice

**Objective:** one vertical slice in which every abstraction carries real load. The test is not
feature count; it is that the same conversation can be driven by more than one provider and reach a real
third-party MCP server through a real permission gate.

### 10.1 In scope

| Area | Phase 1 scope |
|---|---|
| Monorepo | pnpm + Turbo, strict TS, boundary + grep gates enforced from commit one |
| Database | Full `DATA-MODEL.md` model in Atlas, `$jsonSchema` validators, all indexes, migration runner, seed |
| 🔒 Tenancy | `ScopedCollection` + **command-monitoring guard** + adversarial isolation suite |
| Auth | Better Auth (email/password + one OAuth provider + TOTP), workspaces, members, invitations, roles, API keys |
| Authz | RBAC in every API route (server-side), `PermissionBroker` with allow/ask/deny |
| Crypto | Envelope encryption + `EnvKeyProvider`/`LocalFileKeyProvider`; KMS/Vault stubbed |
| Providers | **Three** adapters — Anthropic, OpenAI, Google — all passing the conformance suite |
| MCP | Streamable HTTP, `auto` negotiation, `server/discover`, tools discovery with `ttlMs`/`cacheScope`, `definitionHash` + embedded approval, OAuth (CIMD + RFC 9728/8707/9207), `ToolGateway`, MRTR human path (**inference denied**) |
| Runtime | `stepOnce` + `SlicedExecutor`, budgets, suspension/resumption, compaction, streaming |
| Execution | Mongo lease queue, HMAC internal execute endpoint, stalled-lease sweeper |
| Streaming | SSE over `runEvents` change stream with cursor replay |
| Channels | **Web only** |
| Observability | OTel traces, structured logs, `auditLog`, `usageDaily`, cost, serverless metrics |
| Containers | Dockerfile for `apps/web` **built and booted in CI** |

### 10.2 Explicitly out of scope (requirement 14)

RAG / documents · semantic memory · Telegram · cron / user-facing scheduling · stdio MCP ·
sub-agents · MCP resources & prompts · `subscriptions/listen` · Tasks extension · marketplace ·
custom MCP server creation · public API · billing · Redis · AWS.

> **One boundary clarification:** the internal stalled-lease **sweeper** is execution plumbing, not
> the user-facing scheduling feature. Phase 1 ships no `schedules` collection, no cron UI, and no
> user-visible recurring runs. Flagged so this is not ambiguous at review.

### 10.3 Phase 1 acceptance criteria

Phase 1 is complete when **all** of these hold, and the starred ones run in CI.

| # | Criterion |
|---|---|
| **AC-1** | A user signs up, creates a workspace, invites a colleague; both see the same agent. Sessions are server-side and revocable. |
| **AC-2** | The workspace configures **three** provider configs and three model bindings across Anthropic, OpenAI and Google. |
| **AC-3** | The workspace installs a **real third-party MCP server** over Streamable HTTP, completes the CIMD-based OAuth flow with an RFC 8707 resource indicator, and sees discovered tools pending approval. |
| **AC-4** | An admin approves specific tools and writes policy rules: one `allow`, one `ask`, one `deny`. |
| **AC-5** | A conversation exercises all three paths — `ask` suspends the run, approval resumes it, `deny` returns an explanatory `is_error` tool result to the model. |
| **AC-6** ★ | **The same conversation is continued after switching the model binding Anthropic → OpenAI → Google. History replays correctly; provider artifacts replay verbatim on same-model continuation and are dropped on cross-model continuation.** *(The acceptance test for the entire vendor-independence claim.)* |
| **AC-7** ★ | A tool definition changes server-side; the next discovery invalidates approval **in the same atomic write** and blocks the capability until re-approved, with a diff shown. |
| **AC-8** ★ | A run exceeding its budget terminates cleanly with a partial result and an accurate cost record. |
| **AC-9** ★ | **A run exceeding one Vercel slice yields, is reclaimed, and completes correctly across invocations — with no duplicate tool side effects.** Verified by killing the executor mid-run and by forcing a lease steal. |
| **AC-10** ★ | Adversarial tenant-isolation suite: every repository method queried with a wrong workspace returns empty/throws, **and** the command-monitoring guard throws on any unscoped tenant query. |
| **AC-11** ★ | `grep -rE "gmail\|telegram\|notion\|github\|slack" packages/runtime packages/core` returns nothing. |
| **AC-12** ★ | `grep -rE "anthropic\|openai\|gemini\|google" packages/runtime packages/core` returns nothing. |
| **AC-13** ★ | `grep -rE "vercel\|@vercel" packages/runtime packages/core packages/mcp packages/db` returns nothing — proving the runtime is deployment-agnostic. |
| **AC-14** ★ | All three provider adapters pass the identical conformance suite. |
| **AC-15** | MRTR: a server returning `input_required` suspends the run for human input and resumes correctly; an `inference` request is **denied by default** and audited. |
| **AC-16** ★ | `apps/web`'s Dockerfile builds in CI and the container boots against a test Atlas database — proving container-friendliness is real, not aspirational. |
| **AC-17** ★ | No secret material is reachable from `runs`, `runSteps`, `runEvents`, `auditLog`, logs or LLM context (redaction corpus). |

**AC-6, AC-9, AC-13 and AC-16 are the four that specifically prove requirements 7, 8, 10 and 11.**
They are the reason this slice is shaped the way it is.

---

## Sources

- [The 2026-07-28 MCP Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/) · [release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP TypeScript SDK V2 — protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions) · [`@modelcontextprotocol/client`](https://www.npmjs.com/package/@modelcontextprotocol/client)
- [Vercel Functions — duration limits](https://vercel.com/docs/functions/configuring-functions/duration) · [Functions can now run up to 30 minutes](https://vercel.com/changelog/vercel-functions-can-now-run-up-to-30-minutes) · [`waitUntil` reference](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package) · [Fluid compute](https://vercel.com/docs/fluid-compute)
- [MongoDB Change Streams](https://www.mongodb.com/docs/manual/changestreams/) · [Atlas Vector Search hybrid search with `$rankFusion`](https://www.mongodb.com/docs/atlas/atlas-vector-search/hybrid-search/vector-search-with-rankfusion/)
- [Better Auth — MongoDB adapter](https://better-auth.com/docs/adapters/mongo)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) · [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [MCP 2026 spec and agent authentication — WorkOS](https://workos.com/blog/mcp-2026-spec-agent-authentication) · [DCR → CIMD migration](https://mcporbit.com/blog/migrate-mcp-auth-dcr-to-cimd)
