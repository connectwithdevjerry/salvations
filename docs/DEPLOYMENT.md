# Deployment Architecture

Companion to [../ARCHITECTURE.md](../ARCHITECTURE.md).

**Phase 1 target:** Vercel (Next.js app + API routes) + MongoDB Atlas. **No AWS. No Redis.**
**Designed for:** extracting long-running execution into a separate worker service later, on
Fargate/ECS or any container host, **without rewriting the core runtime**.

---

## 1. The constraint that shapes everything

Verified from Vercel's documentation (2026-09-15):

| Fact | Value | Consequence |
|---|---|---|
| Default function duration | **300 s** (all plans, Fluid compute default) | An agent run can exceed this |
| Configurable maximum | **800 s** GA (Pro/Enterprise); **1800 s** in beta | Set per function, not project-wide, above 800 s |
| `waitUntil(promise)` | Extends the handler past the response… | …**but is still subject to the function's overall timeout** |
| Streaming | SSE over a standard streaming `Response` | Works; counts against the same duration budget |

**The critical line is the third one.** `waitUntil` is *not* a background job runner — it cannot
outlive `maxDuration`. So on Vercel there is no such thing as "fire and forget an agent run."

Therefore: **a run must be executable in bounded slices, resumable across function invocations.**
This is not a workaround — it is the same property that makes a run survive a worker crash, and it
is exactly the seam that lets execution move to a long-lived container later. We get the migration
path for free by respecting the platform constraint honestly.

---

## 2. Phase 1 topology

```
                         ┌──────────────────────────────┐
   Browser ── HTTPS ────▶│         VERCEL               │
                         │   Next.js 16 (App Router)    │
                         │                              │
                         │  ┌────────────────────────┐  │
                         │  │ UI routes (RSC)        │  │
                         │  ├────────────────────────┤  │
                         │  │ /api/auth/*            │  │  Better Auth
                         │  │ /api/workspaces/*      │  │  maxDuration 60
                         │  │ /api/agents/*          │  │
                         │  │ /api/mcp/*             │  │
                         │  ├────────────────────────┤  │
                         │  │ /api/runs/:id/events   │  │  SSE tail  · maxDuration 300
                         │  ├────────────────────────┤  │
                         │  │ /api/internal/execute  │  │  RUN EXECUTOR
                         │  │   (HMAC-authenticated) │  │  maxDuration 800
                         │  ├────────────────────────┤  │
                         │  │ /api/internal/sweep    │  │  stalled-lease sweeper
                         │  └────────────────────────┘  │  maxDuration 60
                         └───────────┬──────────────────┘
                                     │ TLS + SCRAM / X.509
                                     ▼
                         ┌──────────────────────────────┐
                         │      MONGODB ATLAS           │
                         │  replica set (M10+)          │
                         │  · state of record           │
                         │  · runs  = the work queue    │
                         │  · runEvents = change stream │
                         │  · Vector Search (Phase 2)   │
                         └──────────────────────────────┘
                                     ▲
                  outbound HTTPS     │
      ┌──────────────────────────────┴───────────────┐
      ▼                                              ▼
┌───────────────────┐                    ┌────────────────────────┐
│  AI PROVIDERS     │                    │  MCP SERVERS           │
│  Anthropic /      │                    │  Streamable HTTP       │
│  OpenAI / Google  │                    │  (third-party, OAuth)  │
└───────────────────┘                    └────────────────────────┘
```

**Blob storage:** Phase 1 spills oversized payloads to **Vercel Blob** behind the `BlobStore` port.
Swapping to S3/R2 is one adapter. No AWS account is required to start.

---

## 3. The execution model

### 3.1 Two ports, one runtime

The runtime exposes a **single step**, and an *executor* owns the loop. That inversion is the whole
migration strategy.

```ts
// packages/core/src/ports/run-executor.ts
interface Deadline {
  remainingMs(): number;
  expired(reserveMs: number): boolean;
}

interface RunExecutor {
  /** Advance one claimed run as far as this environment allows. */
  execute(runId: RunId, deadline: Deadline): Promise<ExecOutcome>;
}

type ExecOutcome =
  | { kind: 'finished';  status: 'succeeded' | 'failed' | 'cancelled' }
  | { kind: 'suspended'; reason: 'approval' | 'input' | 'tool' }
  | { kind: 'yielded';   resumeAt: Date };   // slice exhausted — run is back in `queued`
```

```ts
// packages/runtime/src/agent-runtime.ts  — environment-agnostic
class AgentRuntime {
  async stepOnce(ctx: RunContext): Promise<StepOutcome> { /* one model call OR one tool phase */ }
}
```

Two executors wrap the identical `stepOnce`:

| Executor | Where | Loop condition |
|---|---|---|
| `SlicedExecutor` | Vercel function | `while (!deadline.expired(RESERVE_MS) && budget.ok())` — then persist, release lease, set `status:'queued'`, request continuation, return `yielded` |
| `ContinuousExecutor` | Worker container (Phase 4) | `while (budget.ok())` — runs to completion or suspension |

`RESERVE_MS` (default 45 s) guarantees enough headroom to finish the in-flight step, persist it,
emit events and release the lease cleanly. A slice never ends mid-step.

**The runtime does not know which executor it is running under.** It has no `if (isVercel)`.

### 3.2 The queue is MongoDB (no Redis in Phase 1)

`runs` doubles as the work queue via a lease-based atomic claim — see `DATA-MODEL.md` §3.3.

```
submit run  →  status: 'queued'
            →  POST /api/internal/execute  (HMAC-signed, fire-and-forget under waitUntil)
            →  claim via findOneAndUpdate  (atomic; only one executor wins)
            →  SlicedExecutor loop
            →  finished | suspended | yielded → re-trigger continuation
```

Two independent liveness guarantees:

1. **Push** — whoever creates or resumes a run triggers `/api/internal/execute` immediately. Low
   latency, the normal path.
2. **Sweep** — `/api/internal/sweep` reclaims runs whose `lease.until` has passed and re-triggers
   any `queued` run older than N seconds. This is the safety net for a lost push, a crashed
   function, or a continuation that never fired.

> **Scope note on requirement 14.** The sweeper is *internal execution plumbing*, not the
> user-facing scheduling feature. Phase 1 ships **no `schedules` collection, no cron UI, no
> user-visible recurring runs**. If the sweeper is driven by a Vercel Cron entry, that is a single
> platform-level heartbeat, invisible to tenants. Flagging it explicitly so the boundary is not
> ambiguous at review time.

### 3.3 Why this survives a worker migration unchanged

| Concern | Phase 1 (Vercel) | Phase 4 (worker service) | Changes needed |
|---|---|---|---|
| Run state | MongoDB `runs` | MongoDB `runs` | **none** |
| Claiming | `findOneAndUpdate` lease | `findOneAndUpdate` lease, or BullMQ | swap `RunQueue` adapter |
| Wake-up signal | HTTP push + sweep | Redis/BullMQ notification | swap `RunQueue` adapter |
| Loop control | `SlicedExecutor` | `ContinuousExecutor` | swap one adapter at the composition root |
| Step logic | `AgentRuntime.stepOnce` | `AgentRuntime.stepOnce` | **none** |
| Event delivery | change stream → SSE | change stream **or** Redis pub/sub → SSE | swap `EventBus` adapter |
| Frontend | consumes `/api/runs/:id/events` | identical endpoint | **none** |

**Redis, when it arrives, is a notification channel — not a state store.** MongoDB remains the
source of truth for run state in both topologies. That is the specific decision that keeps the
migration from becoming a rewrite: a lost Redis message costs latency (the sweeper still finds the
run), never correctness.

### 3.4 Streaming, decoupled from execution

The browser **never** holds a connection to the function executing the run.

```
POST /api/conversations/:id/messages   →  creates message + run, triggers execution, returns runId
GET  /api/runs/:runId/events?after=N   →  SSE; tails `runEvents` via change stream
```

- Reconnect is free: the client passes `after=<lastSeq>` and replays from the durable event log.
- The SSE function hits its own 300 s ceiling; the client simply reconnects with its cursor.
- Because the stream reads a collection rather than a process, **it does not care where execution
  happens.** Moving to a worker is invisible to the frontend — this is what makes §3.3 row 7 true.

Change streams need a replica set; Atlas clusters always are. A `PollingEventBus` fallback
(cursor poll every 300 ms) exists for local single-node development.

---

## 3.5 Current deployment

| Fact | Value |
|---|---|
| Vercel project | `salvations` (`prj_mBtq5RkZZmzniXFbL1iQ9El0gG0z`) |
| Team | Kenny's projects — **hobby plan** |
| Repository | `connectwithdevjerry/salvations` (**public**) |
| Production branch | `claude/epic-gates-clsnom` |
| Root directory | `apps/web` (pnpm workspace; Vercel installs from the repo root) |
| Region | `iad1` |
| Production URL | https://salvations-delta.vercel.app |

Two constraints this imposes, both worth revisiting before Phase 1 ships:

- **Hobby plan caps function duration at 300 s.** §1 assumes up to 800 s on
  Pro. The sliced executor still works — `RESERVE_MS` and slice length are
  configuration — but slices are shorter, so runs yield and resume more often.
  Tune `RESERVE_MS` against the p95 step, not the maximum, and expect a higher
  slice-yield rate on this plan.
- **The production branch is a feature branch**, because the repository had no
  other branch when the project was linked. Once `main` exists, switch the
  project's production branch to it so feature work stops deploying to
  production.

No environment variables are set yet. Before the data layer lands, the project
needs `MONGODB_URI`, `MONGODB_DB_NAME`, `BETTER_AUTH_SECRET`, `CREDENTIAL_KEK`,
`INTERNAL_HMAC_SECRET` and `PUBLIC_BASE_URL` — see `.env.example`.

## 4. Environments

| Environment | Vercel | Atlas | Notes |
|---|---|---|---|
| Local | `next dev` | Atlas free tier **or** local `mongod` replica set (`--replSet rs0`) | single-node RS needed for change streams + transactions |
| Preview | Vercel Preview (per PR) | shared preview cluster, **database per branch** | seeded; never shares a DB with production |
| Production | Vercel Production | dedicated M10+ | |

**Atlas configuration (all environments)**
- Network: IP access list. Vercel egress is not a fixed IP on all plans — Phase 1 uses Atlas
  **Network Peering / Private Endpoint where the plan allows**, otherwise a documented,
  time-boxed open-with-strong-auth posture recorded as an accepted risk in `SECURITY.md`.
- Separate database users: `app` (CRUD, **no** `dropDatabase`, **no** update/delete on `auditLog`)
  and `migrate` (DDL/index management). The app never runs migrations.
- Connection string in Vercel encrypted environment variables, distinct per environment.

**Connection pooling on serverless.** The `MongoClient` is created **once per module instance** and
cached on `globalThis`, never per request. `maxPoolSize` is tuned low (default 10) because Fluid
compute reuses instances across concurrent invocations. A connection-churn metric is part of the
Phase 1 observability checklist — pool exhaustion is the classic serverless-Mongo failure and it
presents as latency, not errors.

---

## 5. Container-friendliness (no AWS yet, no lock-in later)

Requirement 8: do not introduce AWS, but stay portable.

- **Every app is a standard Node 22 process.** `apps/web` runs on Vercel *and* under
  `next start` in a container. `apps/worker` (Phase 4) is a plain Node entrypoint.
- **Dockerfiles exist from Phase 1** for `web` and a placeholder `worker`, built in CI and pushed
  nowhere yet. They are verified by a CI job that builds and boots the image against a test Atlas
  database. A Dockerfile that is never built is a Dockerfile that does not work.
- **No Vercel-only API in shared packages.** `waitUntil` and any `@vercel/*` import appear **only**
  in `apps/web/src/app/api/**`, behind the `BackgroundTrigger` port. Enforced by
  `dependency-cruiser`.
- **Configuration is environment variables only** — no Vercel-specific config resolution in
  `packages/*`.
- **Blob storage behind `BlobStore`**; Vercel Blob adapter in Phase 1, S3-compatible adapter ready.
- **Secrets behind `KeyProvider`**; `LocalFileKeyProvider` (dev) and `EnvKeyProvider` (Vercel) in
  Phase 1, `KmsKeyProvider`/`VaultKeyProvider` interfaces stubbed but unimplemented.

**Migration to ECS/Fargate later is:** build the existing `apps/worker` image, point it at the same
Atlas cluster, swap `SlicedExecutor` → `ContinuousExecutor` and `MongoRunQueue` → `RedisRunQueue` at
that app's composition root. Vercel keeps serving UI, API and SSE. No shared package changes.

---

## 6. Observability

- OpenTelemetry traces: `run → step → model_call | tool_call`, exported OTLP to a vendor-neutral
  collector. No vendor SDK in application code.
- Structured JSON logs with redaction middleware (`SECURITY.md` §5).
- Health: `/api/health` (liveness) and `/api/health/ready` (Atlas ping, provider reachability).
- **Serverless-specific metrics that must exist in Phase 1:** cold-start rate, Mongo connection
  churn, slice-yield rate (how often runs hit the deadline), sweeper reclaim count, SSE reconnect
  rate. These four are how you find out the execution model is misconfigured before users do.

---

## 7. Deployment risks specific to this topology

| # | Risk | Mitigation |
|---|---|---|
| D1 | A run needs more wall-clock than one slice and continuation never fires | Sweeper reclaims by expired lease; `attempts` capped, then run fails cleanly with a partial result |
| D2 | Two executors process the same run | Atomic lease claim + **every write guarded by `lease.token`**; a stolen-lease executor cannot write |
| D3 | Mongo connection exhaustion under Fluid compute concurrency | Cached client on `globalThis`, low `maxPoolSize`, churn metric with an alert |
| D4 | Long MCP tool call blows the slice budget | Per-tool-call timeout < `RESERVE_MS`; longer work uses the MCP **Tasks** extension (Phase 3) and suspends to `waiting_tool` |
| D5 | Change stream unavailable (local single node not configured as RS) | `PollingEventBus` fallback, selected by capability probe at startup |
| D6 | Vercel egress IPs not stable for Atlas allowlisting | Private endpoint / peering where available; otherwise documented accepted risk with strong auth + TLS |
| D7 | Cost blow-up from long `maxDuration` functions billed on Fluid compute | Slice length tuned to the p95 step, not the max; per-workspace concurrency cap; daily cost cap enforced in the runtime |
