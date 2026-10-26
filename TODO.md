# HIVE — Implementation Roadmap

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) and the documents in [docs/](./docs).

**Current state:** Phase 1 complete through §1.10 and Phase 1.5 through §1.5.8, plus the plan
gate (10-day trial or subscription before the first assistant), the rules editor on the Approvals
page with "Approve all" and a twenty-minute auto-approve window, apps connected more than once,
five channels at parity (Telegram, WhatsApp, iMessage via the person's own Mac, Slack, Discord)
with buttons, pictures, clips and voice notes where each platform allows, Telegram, Slack and
WhatsApp connected in one press from the deployment's own bot and apps ("Connect Telegram",
"Add to Slack", Meta's Embedded Signup; Discord stays manual by decision) with the do-it-yourself path kept behind a link, HIVE AI as the
model that comes with the subscription (the deployment's own key, a monthly allowance per
workspace, the person's own key still welcome), the deployment's keys settable from the admin
dashboard by a platform admin without a redeploy, a studio for pictures
and clips, every role able to take a bare link or name and do the whole job, an Academic outreach
role that searches, and publishing to Instagram, Facebook, LinkedIn and Shopify once the person
says yes; what remains in Phase 1 is the manual acceptance pass and the runbooks.
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
- [x] Bind the executor in `/api/internal/execute` — needs the composition root, which lands
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
- [x] Policy editor UI + `/policies` routes (the Rules section of the Approvals page)
- [x] MCP OAuth consent flow wired end to end (the client exists; the callback route does not)
- [ ] **(AC-2) (AC-4) (AC-5)** exercised through the UI — needs a live database and real keys

### 1.10 Observability & containers

- [x] OTel traces `run → step → model_call | tool_call`; OTLP export
      *(OTLP/HTTP JSON written directly — the wire format, not the SDK; see
      `packages/observability/src/tracing.ts` for the trade and the seam)*
- [x] Structured logging + 🔒 redaction middleware
- [x] `auditLog` writer wired to the gateway (tool calls, refusals, approvals)
- [x] `auditLog` for admin actions (members, invitations, settings, disconnects, chat decisions);
      credential resolution is logged by the gateway on every tool call
- [x] `usageDaily` rollups; cache-hit-rate alert
- [x] `/api/health` + `/api/health/ready`
- [x] ⚓ **(AC-16)** `apps/web` Dockerfile built **and booted** in CI against a test database
- [x] ⚓ `apps/worker` placeholder: Dockerfile + entrypoint that claims and runs one run via
      `ContinuousExecutor` — *not deployed*, but compiled and smoke-tested so Phase 4 is a
      configuration change rather than a discovery exercise
- [x] Tracer wired into the executor: run → step → model_call | tool_call | compaction, flushed
      before each invocation returns; OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set

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
- [x] `packages/channels` — `ChannelAdapter` port + Telegram, WhatsApp, iMessage (own Mac), Slack, Discord
- [x] 🔒 Per-platform delivery authentication: echoed secret, HMAC-SHA256 (Slack, WhatsApp),
      Ed25519 (Discord), and a confirm round trip to the person's own Mac where nothing can sign
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

### 1.5.3 Billing — done, trial first

- [x] `packages/catalog/plans` — the plan, hard-coded
- [x] `packages/billing` — `PaymentProcessor` port + Stripe over its REST API
- [x] 🔒 Webhook signature + replay window; all-or-none env configuration
- [x] Entitlements that fail OPEN when no processor is configured
- [x] Checkout page; card details never reach this codebase
- [x] A limit reached does something: the workspace's daily cap and the plan's monthly cap stop
      new runs starting (in flight finishes); the plan's counts refuse the next assistant, channel
      or app with the arithmetic; the admin dashboard shows each ceiling as a meter
- [x] Customer portal: the processor's own page for the card and invoices, from the billing page

### 1.5.4 Knowledge, memory and the agent's server — done

- [x] `packages/knowledge` — text extraction (text, Markdown, HTML, CSV, JSON, PDF, Word), paragraph-first
      chunking with overlap, two-signal ranking
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
- [x] PDF (pdf.js, text layer only; a scan is refused with the word OCR) and Word (.docx opened as
      the zip it is, paragraphs and table rows) ingestion
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
- [x] Vendor MCP URLs checked against what the vendors publish (Asana `/v2/mcp`, Box and HubSpot
      at the host alone were corrected). Asana and HubSpot register OAuth clients by hand only:
      `MCP_OAUTH_CLIENTS` holds those, keyed by vendor domain, and the entries are refused until set
- [x] Google Workspace: our own adapter in `packages/servers` (Gmail search/read/send/label,
      Calendar list/create, Drive search/read over Google's REST APIs), consent on Google's own
      screen with the deployment's Google client (`access_type=offline`, PKCE), tokens in the
      encrypted OAuth store per assistant binding, refreshed a minute before expiry. A catalogue
      entry with `native` installs an `in_process` server row; the opener builds the adapter
      for its alias. Google Cloud must list `<PUBLIC_BASE_URL>/api/mcp/callback` as a redirect
      URI and have the Gmail, Calendar and Drive APIs enabled
- [x] Tool definitions stored verbatim: the capability upsert is a pipeline update, and a JSON
      Schema's `$schema` key was parsed as an operator, so every first-party server's discovery
      failed at the write ("the server would not list its tools"). Server-sent values now pass
      through `$literal`; verified against MongoDB 7, with a server test in `packages/db`
- [x] In-process servers callable: the registry refused every transport but HTTP at call time,
      so a listed first-party tool answered "no such tool". `in_process` resolves with no URL.
      The client manager opens an in-process server per operation and closes it after, so a
      warm process never hands one run's conversation or memory to the next
- [x] An unanswered tool call is answered at prompt assembly: a run that ended between the
      model's request and the tool results left a `tool_use` nobody answered, and the next
      message made every provider reject the history. The assembler now answers it with an
      error result that says so, in the message right after, leaving history append-only
- [x] Reads run, writes ask: under the workspace default of `ask`, a first-party tool and a
      verified app's tool that declares itself read-only and not destructive run without a
      click; everything else, and everything untrusted, still asks. Matches the promise on the
      landing page and in the walkthrough ("before it sends, deletes or pays")
- [x] A new message supersedes a run waiting for approval: its question is recorded as declined
      and the run cancelled, so it cannot wake into the middle of a newer exchange. The chat
      shows a pending approval after a reload, not only in the stream that first carried it
- [x] The event stream's change-stream watch and probe declare platform intent, so the tenancy
      guard no longer reports them on every request
- [x] A Telegram bot registered before button presses were asked for never heard a press, so
      Approve did nothing and said nothing. The webhook is re-registered the moment buttons are
      sent on a stale connection, and on the next inbound message; the daily sweep stays
- [x] Drop and go: every role treats a bare link, name, file or photo as the whole brief, does the
      job whole and asks once at the end, and each role says what a drop means for it (a receipt
      for Finance, a CV for People, a customer's message for Support). Marketing makes a
      ready-to-publish pack (hook, caption, description, hashtags, times, platforms) and the
      picture or clip to go with it. An assistant created before the rule gets it at run time,
      read from the role heading in its instructions, so nobody has to recreate a team
- [x] The studio: a first-party server (`studio`) with `create_image`, `create_video` and
      `check_video`, drawn by the workspace's own OpenAI key through the provider port
      (`generateImage`, `startVideo`, `videoJob`, `videoContent`; no vendor named outside the
      adapter). What it makes is kept in the workspace's own `media` collection, capped at 15 MB,
      and served by a signed link at `/api/media/<id>` that a chat platform can fetch. Telegram is
      sent the picture itself after the words (`sendMedia`); a clip renders for minutes, so the
      execute function stays up after the answer and sends it when it lands, and the link, the
      check tool or the next look settle whatever was left. The web chat shows a studio link on
      its own line as the picture or the player
- [ ] Publishing where the post goes: Instagram and Facebook Pages (Meta Graph API), LinkedIn,
      Shopify, Mailchimp are native adapters still to build, each with the vendor's own app and
      review. Until then "publish" means the connected apps: mail, Notion, Canva, tasks
- [x] Academic outreach, a role: a professor's name and a university become a considered cold
      email. The assistant searches and browses for itself (the web `search` and `read_page`
      tools, Google Programmable Search configured in production), reads the faculty page and
      the lab, pulls the papers from the open Semantic Scholar API and arXiv, picks the paper
      closest to the person's interest, summarises it under five headings (background, data acquisition, methodology, findings,
      limitations), proposes one
      improvement, weaves in the CV from the knowledge base, and asks for approval before
      sending through the connected mail account. A weekly routine chases the unanswered
- [x] More than one account per app: an assistant may connect the same app several times (two
      Google accounts, two Stripe accounts). Each connection gets its own alias (`google_workspace`,
      `google_workspace_2`), its own tokens and its own tool prefix; a name the person gives it
      ("Sales inbox") goes into every tool description so the model tells them apart. The app
      panel lists the accounts with their own authorise and disconnect, and adds another
- [x] Who registers apps by hand, from what the vendors answer today: GitHub and Box offer no
      dynamic registration (a GitHub App or Box app goes in `MCP_OAUTH_CLIENTS`); Asana does,
      so it no longer waits on one. Every catalogue server answered 401 with resource metadata
      and PKCE S256, which is the whole handshake HIVE relies on
- [x] Pay or try first: a workspace runs assistants on a subscription, a 10-day free trial
      (one click, no card, once per workspace, `POST /billing/trial`), or the operator's
      exemption (`COMPLIMENTARY_WORKSPACES`). Nothing else makes or runs an assistant: the
      create pages send a new person to the plan page and bring them back once the trial has
      started; a chat message on an unentitled workspace is answered with the reason. The plan
      page says the days left, the Settings card says the state, the landing page says the
      offer. Stripe unconfigured now means "cannot pay yet", not "everything is free"
- [x] Rules editor: on the Approvals page, one list per scope (every assistant, or one). A rule
      is an effect (allow, ask, never), an app (any, a built-in, or a connection), a tool name or
      glob, and an optional per-run cap. The workspace default sits above it. `GET`/`PUT`
      `/policies?scope=`; admins write, members read. "Allow and stop asking" on an approval
      card records an allow rule for that tool and connection, for the assistant that asked
- [x] A first-party binding has no row, so the permission broker judged it untrusted and the
      assistant asked before remembering anything, three times for one request. The host now
      tells the broker which ids are its own; a policy's own label ("policy:default") is no
      longer shown to people as a reason
- [x] A run woken after its conversation moved on finishes with what it last said instead of
      calling the model with a history that ends on its own turn; an approval for a run that is
      no longer waiting is refused, on the page and in the chat
- [x] The assistant server is an OAuth 2.1 authorization server (RFC 9728/8414/7591/7636/8707):
      Claude.ai and ChatGPT connect by URL, the person consents on `/oauth/authorize` with the
      HIVE login, tokens are opaque and hashed (`oauthGrants`), refresh rotates with family
      revocation on replay
- [x] Disconnecting an integration: tokens (revoked at Google), every person's row, discovery,
      the gateway token and the server row when unused; Google tokens renewed by the sweeper six
      hours before they lapse, and a grant Google ends marks the binding as needing authorisation

### 1.5.6 Every assistant is an MCP server — done

- [x] `/mcp/w/{workspace}/assistants/{assistant}` — created with the assistant, served stateless
      over streamable HTTP through `packages/servers`, authenticated with our own keys
- [x] One surface: `ask` (a real run — model, memory, knowledge, every integration, approvals
      included), `describe`, `recall`, `remember`, `search_knowledge`, `conversations`
- [x] `assistantSurface()` is the single definition of what an assistant can do; runs, the
      `capabilities` tool and the server all read it
- [x] API keys can finally be minted, listed and revoked; scopes are capped at the minter's own
- [x] Server tab: URL, what it unites, keys shown once, client config
- [ ] Re-export integration tools raw on the assistant's server — see §1.5.7
- [x] OAuth on the assistant's server: an OAuth 2.1 authorization server (RFC 9728/8414/7591/
      7636/8707), consent on `/oauth/authorize` with the HIVE login, opaque hashed tokens

### 1.5.7 Two things that want a long-lived process

Both were assessed and neither fits a request-shaped deployment, so neither is half-built.

- [ ] **Raw integration tools on the assistant's MCP server.** A client calling, say,
      `gmail__send` straight through the assistant's server would hit policy's `ask` and need
      the call to wait for a person. Inside a run, waiting is a suspended run: no process held,
      resumed by the queue. Outside a run there is nothing to suspend: the MCP request is open
      on a serverless function with a wall of seconds, and the person may answer tomorrow. The
      honest shapes are (a) the MCP Tasks extension (`tasks/get` on a task id the client polls),
      which Phase 3 lists and which fits the queue model exactly, or (b) a long-lived worker that
      can hold the request. Until one exists, `ask` is the route: it IS a run, so it waits
      properly, and the tool runs with the assistant's memory and knowledge around it.
- [ ] **Discord as a conversation (Gateway).** Discord's Gateway is a WebSocket the bot holds
      open; a webhook deployment gets only slash-command interactions, which is what Discord is
      today. Holding the socket needs the Phase 4 worker. Once it exists, the adapter gains a
      `listen` that turns Gateway `MESSAGE_CREATE` events into the same `InboundMessage` the
      webhook path makes, and nothing above the adapter changes.

### 1.5.8 Chat depth — done

- [x] Approvals decided from Telegram: the question goes to the chat with Approve / Not now
      buttons; a press from the identity that owns the conversation decides it and wakes the run;
      the message is rewritten with the outcome. Buttons are optional on the channel port.
- [x] Chat identities linked to accounts: a ten-minute code from Settings, sent as `link CODE`,
      matched by hash and honoured only for a member of the chat's workspace; linked identities
      run as `trust: 'linked'` with the person's account on the run

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
- [x] Extractors: PDF, DOCX, HTML, Markdown, plain text (shipped in §1.5.4)
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
- [x] `trustTier`-driven approval defaults; scoped remembered decisions (R14): reads run under
      `ask` by tier and annotation, and "Allow and stop asking" writes an agent-scoped rule

## Phase 4 — Separate worker service ⚓

*This phase should be small. If it is not, the Phase 1 seams were wrong.*

- [ ] Promote `apps/worker` to a real service: `ContinuousExecutor` + long-lived Mongo connection
- [ ] `RedisRunQueue` (BullMQ) as a **notification** layer — MongoDB stays the source of truth
- [ ] `RedisEventBus` alongside the change-stream bus
- [ ] Per-workspace rate limits and queue groups (noisy-neighbour control)
- [ ] Deploy to ECS/Fargate (or any container host) against the same Atlas cluster
- [ ] Vercel keeps serving UI, API and SSE — **frontend unchanged**
- [ ] 🔒 Verify: no change required in `packages/core`, `packages/runtime`, or `packages/mcp`
- [ ] Then: sub-agent orchestration, which wants a long-lived executor (scheduling shipped in
      §1.5.2 on the sweeper's tick)

## Phase 5 — Channel depth & first-party MCP servers

*The channels themselves shipped in Phase 1.5. What is left here is depth.*

- [x] Telegram `ChannelAdapter`: webhook + secret verification 🔒
- [x] 🔒 Unlinked identities are minimal-privilege (`trust: 'unlinked'` on the run's principal)
- [x] Throttled edits (the live draft) and inline-keyboard approvals on Telegram (§1.5.8)
- [x] 🔒 `channelIdentities` linking flow (§1.5.8)
- [x] Slack and Discord at parity with Telegram: approval buttons (Block Kit, message
      components), pictures and clips (image block and file upload; embed and link), the live
      draft, typing on Discord, voice clips on Slack. Discord's `/hive` command is created by
      `register`, and the interaction is answered in the HTTP response (a word under the
      command, the rewritten message for a press) so Discord never shows "did not respond".
- [x] The hero's channel word rotates through where you can text it (Telegram, Slack,
      Discord, the web, Claude.ai, ChatGPT). Only places that work today.
- [x] WhatsApp through Meta's Cloud API, on the person's own Meta app and number: signed
      deliveries (X-Hub-Signature-256 with the app secret), the GET probe answered with a verify
      token derived from that secret, reply buttons (three, 20-char labels), pictures and clips by
      link, voice notes fetched in Meta's two steps, read-and-typing tied to the message answered.
      The port grew `extraField`/`composeToken` (phone number id beside the token), `verifyToken`
      and `verify` (the probe), and `indicate` takes the message ref.
- [x] iMessage through the person's own Mac running the open-source BlueBubbles server. Apple has
      no API; this is the one route that keeps the messages on the person's hardware. The Mac
      cannot sign what it posts, so the port grew `confirm`: the message is looked up on the Mac
      before anything is written. Text, pictures and clips as attachments, voice memos as mp3,
      typing where the Mac's private API is on. No buttons (a question is asked in words), no
      drafts (Messages cannot edit).
- [x] Approvals page: "Approve all" for the waiting tool calls, each its own decision on the
      server, questions that need an answer left alone.
- [x] Instagram & Facebook publishing, a first-party server over Meta's Graph API on the
      deployment's own Meta app (`META_APP_ID`/`META_APP_SECRET`): consent on Meta's screen,
      short token traded for a sixty-day one, renewed by the sweep in its last week; pages and
      linked Instagram accounts listed, posts to a page (text, link, picture, clip), Instagram
      pictures and reels in Meta's two steps with the processing wait handed back as a creation
      id. Every publishing tool is a non-idempotent write, so policy asks first. Marketing's
      duties say to publish there once the person says yes. The callback's native finish is
      shared between Google and Meta.
- [x] LinkedIn publishing, a first-party server over the Posts API on the deployment's own
      LinkedIn app (`LINKEDIN_CLIENT_ID`/`SECRET`, `LINKEDIN_SCOPES` for page posting): consent on
      LinkedIn's screen, sixty-day tokens with refresh where the app has it, the sweep renewing in
      the last week; the person and the pages they administer as authors; a post with words, a
      link, a picture uploaded in LinkedIn's two steps, or a clip uploaded in LinkedIn's parts
      (initialise with the size, PUT each range keeping the ETag, finalise), posted once LinkedIn
      says it is available, the video id handed back when that takes longer than one call.
- [x] Shopify, a first-party server over the Admin GraphQL API with a custom-app token the
      merchant makes in their own admin (the gateway-token form, relabelled): search, read, create
      as a draft with price and picture, update, add a picture or a clip (Shopify fetches and processes the mp4), put on sale, recent orders. The
      store is asked who it is before anything is stored.
- [x] Integrations tab: the capabilities awaiting review scroll inside a window, and the
      approved list is folded behind "Show the N approved tools" with a filter.
- [x] Connecting a channel: the numbered setup steps (six for WhatsApp) sit in their own
      scrolling box with a capped height, so the address and token fields below never leave
      the dialog. One component (`SetupSteps`), so the same box serves Ways to talk, the tools
      panel and the new-assistant wizard. The scrollbar is always drawn.
- [x] Slack setup tells the truth about Slack's own app settings: a step for App Home → Show
      Tabs → Messages Tab (without it a DM to the app says "Sending messages to this app has
      been turned off"), the install step says where the Bot User OAuth Token appears, and the
      signing-secret step says it lives on a different page (Basic Information).
- [x] "Add to Slack": one Slack app owned by the deployment (`SLACK_CLIENT_ID`/`SECRET`/
      `SIGNING_SECRET`), installed into any workspace from a button. The state through Slack's
      redirect is a signed token naming workspace, assistant and person (`slack-app.ts`); the
      callback refuses anyone else, redeems the code with Basic auth, proves the token with
      auth.test, and stores a connection that is live at once (`ChannelDoc.install`, no
      handshake, every chat in that workspace allowed). Slack delivers for every such workspace
      to one shared address (`/api/channels/slack/app`), signed with the app's secret and routed
      by the team id inside the delivery (`handleSharedDelivery`). One Slack workspace maps to one
      HIVE workspace. Disconnecting revokes the token at Slack. The do-it-yourself path with the
      person's own app stays behind "Prefer your own Slack app?".
- [x] "Add to Discord" is switched OFF by decision (`DISCORD_ONE_PRESS = false` in
      `discord-app.ts`): Discord is connected the manual way, with each workspace's own
      application. The code below stays whole; the one constant turns it back on.
- [x] "Add to Discord": one Discord application owned by the deployment
      (`DISCORD_APPLICATION_ID`/`CLIENT_SECRET`/`PUBLIC_KEY`/`BOT_TOKEN`), added to any server from a
      button (`discord-app.ts`; the signed state is shared with Slack in `install-state.ts`).
      `identify` is asked for beside `bot` and `applications.commands` so Discord comes back with a
      code, and the token answer names the guild, which is the proof. The bot token is the
      application's, so each connection holds a copy and the sweep brings copies up to date when
      the deployment rotates it. One shared interactions endpoint (`/api/channels/discord/app`),
      verified with the application's public key, routed by `guild_id`; a DM names no server, so it
      is answered in the response with "use /hive in a server". `/hive` is created on the
      application at the first install.
- [x] Once a channel is connected, an "If something looks off" panel (`AFTER_CONNECT` in
      `channel-fields.ts`) lists the platform's usual snags with the fix: Slack's messages-tab
      setting, inviting the app to a channel, reinstalling after a scope change, the request
      URL saving only after connecting; Meta's test-number recipients and the 24-hour window;
      Discord's command refresh. Shown in the tools tab and the new-assistant wizard.
- [x] The front door's voice console is live: the browser's own speech recognition hears the
      visitor, a scripted brain (`landing-brain.ts`, keyword rules over this page's facts) answers,
      the browser reads it back. No key, no server, nothing sent anywhere, and the console says it is
      a demo. A browser that cannot hear gets the still picture and a line saying which can.
- [x] Approvals that cannot be answered are closed as the list is read (expired, or the run
      moved on: cancelled, superseded, failed), with the reason as the decider, so the page and
      the badge never show a question that "approve all" would meet as already gone.
- [x] "Auto-approve for 20 min": a policy rule with an end (`PolicyRule.expiresAt`, skipped by
      the engine once past), written to the workspace by `PUT policies/auto-approve`, removed by
      `DELETE`. What is waiting is approved as it opens; a deny still wins; the banner on the
      Approvals page says when it closes and offers Stop. The editor carries `expiresAt` through
      so a save cannot turn the window into a permanent allow-all.
- [x] WhatsApp in one press: Meta's Embedded Signup on the deployment's Meta app
      (`META_WHATSAPP_CONFIG_ID`, `META_WHATSAPP_VERIFY_TOKEN`). Meta's SDK opens its window from
      the browser (`whatsapp-signup.tsx`, loaded only on the press); the page sends the code
      (thirty seconds to live) with the phone number id and Messaging account id Meta's window
      posted; the server (`whatsapp-signup.ts`) redeems the code for the business token, finds the
      account and number through debug_token when the window did not say, subscribes the app to
      the account's webhooks, registers the number with a six-digit pin kept as a credential, and
      stores the connection live. One shared callback (`/api/channels/whatsapp/app`), signed with
      the app secret, routed by the phone number id in each delivery; Meta's GET probe is
      answered with the chosen verify token. Until Meta's App Review, only the app's admins and
      testers can connect.
- [x] HIVE AI, the model that comes with the subscription (`platform-ai.ts`): a deployment key
      (`PLATFORM_AI_API_KEY`, vendor `PLATFORM_AI_PROVIDER` defaulting to openai, chat model and
      monthly cap configurable) gives every workspace a provider called HIVE AI, created at
      workspace creation and on the first read of models for older workspaces, bound to the
      vendor's default roles under the "HIVE AI · model" name, only for roles nothing else holds.
      The provider row carries no credential: every place a provider key is read
      (`providerCredentials`: runs, hearing, embeddings, the studio, the key check) takes the
      deployment's key from the environment for it. `spendGate` learns which binding will answer
      and refuses with the allowance message once the month's HIVE AI spend reaches the cap; a
      key the person brought is theirs to spend. It cannot be removed; the Models page shows it
      as Included, the wizard offers "Continue with HIVE AI", and the landing page and plan say
      AI is included.
- [x] Deployment settings on the admin dashboard (`platform-settings.ts`, `PlatformSettingsRepository`
      in a global `platformSettings` collection): the keys the deployment holds (HIVE AI, the Slack,
      Discord and Meta apps, WhatsApp sign-up, LinkedIn, Google Workspace) can be set and cleared by
      a platform admin (`PLATFORM_ADMIN_EMAILS`) without a redeploy. Secrets are envelope-encrypted
      under the KEK like every stored credential and never shown back; a dashboard value wins over
      the environment variable and is in force within a minute (one cache per process). Every
      getter (`slackApp`, `discordApp`, `whatsappSignup`, `platformAi`, `metaOAuthClient`,
      `linkedInOAuthClient`, `googleOAuthClient`) reads through it and is async. The page is `/admin`,
      with the same section repeated at the bottom of a workspace's admin dashboard.
- [x] Telegram in one press through a shared bot (`telegram-bot.ts`, `TELEGRAM_BOT_TOKEN` or the
      dashboard): the press makes a connection waiting for its chat, with a code and a t.me link
      that carries it; the bot's one webhook (`/api/channels/telegram/app`, secret derived from the
      token, pointed at the deployment on the first press) is routed by chat id, and a chat nobody
      has connected is claimed by the code in its first message across all workspaces
      (`claimTelegramChat`), then bound (`bindInstall`). Disconnecting forgets the row and never
      unhooks the shared bot. The sweep refreshes token copies on rotation as for Discord. The
      person's own bot stays the long way. iMessage cannot be one press: Apple has no API.
- [ ] Channel capability matrix as a test: which adapter has which optional method
- [ ] Discord over the Gateway once there is a worker that can hold a socket, so it is a
      conversation rather than a slash command
- [x] First-party MCP servers: memory, knowledge, chat, web, studio, Google Workspace, Instagram &
      Facebook, LinkedIn, Shopify, the agent gateway
- [x] In-process transport — same client interface, same `ToolGateway`
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
