# Security Model

Companion to [../ARCHITECTURE.md](../ARCHITECTURE.md). Covers authentication, authorization,
tenant isolation, credential handling, MCP-specific threats, and the risk register.

---

## 1. Principals

Everything that can act is a `Principal`. There is no ambient authority anywhere in the system.

```ts
type Principal =
  | { type: 'user';             userId: string; workspaceId: string; role: Role }
  | { type: 'api_key';          apiKeyId: string; workspaceId: string; scopes: Scope[] }
  | { type: 'channel_identity'; identityId: string; workspaceId: string;
                                userId?: string; trust: 'linked' | 'unlinked' }
  | { type: 'agent';            agentId: string; runId: string; workspaceId: string;
                                onBehalfOf: Principal }
  | { type: 'system';           reason: 'sweeper' | 'migration'; workspaceId?: string }
```

**Delegation rule — the anti-escalation invariant:**

```
effective(agent) = grants(agentVersion) ∩ grants(onBehalfOf) ∩ grants(workspacePolicy)
```

An agent can never exceed the person or key that triggered it. The `onBehalfOf` principal and its
effective grants are **snapshotted into `run.principal`** at run creation, so a suspended run that
resumes days later is evaluated against the grants it was authorised with — and revocation is
checked again on resume. A run whose principal has lost access **fails closed**.

---

## 2. Authentication

| Surface | Mechanism |
|---|---|
| Web console | **Better Auth** + `@better-auth/mongo-adapter`. Argon2id password hashing, httpOnly / `SameSite=Lax` / `Secure` cookies, rotating session tokens, TOTP 2FA, email verification, OAuth social provider |
| API | `Authorization: Bearer sk_<env>_<prefix>_<secret>`. Only a SHA-256 hash is stored; `prefix` is the indexed lookup handle; constant-time comparison; `lastUsedAt` written out-of-band |
| Internal execution endpoints | HMAC-SHA256 over `(path, body, timestamp)` with a dedicated secret, ±60 s clock skew window, replay-protected by `(runId, lease.token)` idempotency. **Never reachable with a user session cookie.** |
| Channels (Phase 4) | Webhook secret header + source verification; the sender becomes a `channel_identity`, **unlinked by default** |

**Session security.** Sessions are server-side records in MongoDB (Better Auth), so revocation is
immediate and global. Password reset, email change and 2FA enrolment all invalidate existing
sessions. Rate limiting on auth endpoints uses Better Auth's atomic MongoDB counters.

**Channel identity linking (Phase 4, designed now).** An unlinked channel user is a *stranger* — not
a workspace member. They may interact only with agents explicitly marked `public`, under a
restricted policy and low rate limits. Linking requires a one-time code generated in the web
console. This is what prevents "anyone who finds the bot inherits the workspace's credentials."

---

## 3. Authorization — three layers

### 3.1 RBAC (coarse, in the API layer)

`role ∈ {owner, admin, member, viewer}` → permission sets over resource kinds (agents, MCP
bindings, credentials, policies, conversations, settings, billing). Roles expand to permissions in
code, so permissions can be refactored without a data migration.

**Every authorization decision is server-side.** The web UI hides what a user cannot do as a
courtesy; it is never the enforcement point. Every API route resolves a `Principal`, derives a
`WorkspaceScope`, and checks permission before touching data.

### 3.2 Tenant isolation (structural)

See §4 — this is the layer most changed by the move to MongoDB.

### 3.3 Capability policy (fine-grained, the interesting layer)

`PermissionBroker` evaluates **every** MCP invocation. No exemptions, including platform-owned
servers.

```
Input: (principal, agentVersion, bindingId, capabilityName, arguments, runContext)

1. Capability usable?
     cap.approval.state === 'approved' && cap.approval.definitionHash === cap.definitionHash
     → otherwise DENY (reason: capability_changed | not_approved)

2. Load policy documents for scopes: workspace → agent → principal   (≤ 3 reads)

3. Flatten rules; order by (priority DESC, specificity DESC)

4. Resolve effect:
     any DENY match  → DENY (deny is absolute — it outranks any priority)
     else            → highest priority wins; ties broken by specificity;
                       an exact tie favours ASK
     else            → workspace.settings.defaultToolEffect   (ships as 'ask')

   Specificity ranks pattern precision first, then binding precision, then scope:
       specificity = patternPrecision*100 + bindingPrecision*10 + scopeRank
   Pattern-first is deliberate. An earlier draft had ASK unconditionally beat
   ALLOW, which makes "generally ask, but these specific read-only tools are
   fine" inexpressible — and that rule is the main defence against approval
   fatigue (R14). Safety is preserved by deny being absolute and the default
   being `ask`, not by refusing to let an operator write a narrower allow.

5. Evaluate constraints: argument matchers, maxCallsPerRun, maxCallsPerHour,
   time windows, value thresholds

6. Apply MCP annotations as a FLOOR, never a ceiling:
     annotations.readOnlyHint === false  ⇒  minimum effect 'ask' for non-first-party trust tiers
     A server claiming to be harmless can never downgrade a policy.

7. Write auditLog + runSteps.toolCalls[].permissionDecision
```

Two properties carry the weight:

- **Fail closed.** No matching rule ⇒ workspace default ⇒ `ask`. A newly discovered tool is never
  silently callable.
- **Server-supplied metadata can only tighten.** MCP annotations, titles and descriptions come from
  code we do not control.

An `ask` decision **suspends the run** (`waiting_approval`) and persists an `approvals` document.
No process is held open. On decision the run resumes from its persisted step.

---

## 4. Tenant isolation without row-level security

### 4.1 The honest tradeoff

The previous revision of this architecture used PostgreSQL **Row-Level Security** as a structural,
database-enforced tenancy guarantee. **MongoDB has no equivalent.** Atlas offers per-user role
restrictions, but they do not scale to per-workspace granularity for thousands of tenants.

This is a **real reduction in structural guarantee**, and it is stated plainly rather than papered
over. It is accepted because MongoDB Atlas is the chosen database, and it is compensated by making
the application-layer guarantee *mechanised* rather than *disciplined*.

### 4.2 Compensating controls (all Phase 1)

**C1 — `ScopedCollection` is the only access path.** `packages/db` exports no raw driver objects.
Every filter is merged with `{ workspaceId }`; every insert is stamped; every aggregation pipeline
is prefixed with `{ $match: { workspaceId } }`; `$lookup` / `$unionWith` sub-pipelines must carry
their own workspace match or are rejected.

**C2 — 🔒 The command-monitoring tenancy guard.** The MongoDB Node driver supports command
monitoring. With `monitorCommands: true`, a `commandStarted` listener inspects **every** command
issued on the connection:

```
for each command against a tenant-scoped collection:
    extract filter / pipeline / update / delete predicate
    if workspaceId is not constrained  →  VIOLATION
        dev · test · CI  →  throw   (the build fails)
        production       →  CRITICAL log + audit entry + page
```

This catches an unscoped query **regardless of the code path that produced it** — including one
that bypassed `ScopedCollection` entirely, or a raw driver call smuggled in through a dependency.
It is the closest mechanical analogue to RLS available on MongoDB. An allowlist covers the
deliberate exceptions (Better Auth's global `user`/`session` collections, the `runs` queue-claim
index, platform catalog reads); the allowlist is small, explicit and reviewed.

**C3 — Vector search filters are inside the search stage.** `$vectorSearch` is not constrained by a
later `$match` — the tenant filter must be *within* the stage, against an indexed `filter` field.
The wrapper enforces this specifically (Phase 2). Getting this wrong is a silent cross-tenant leak
that no downstream gate would catch.

**C4 — Index discipline.** Every tenant-scoped index is `workspaceId`-prefixed, so an unscoped
query is also a collection scan — slow enough to notice in monitoring.

**C5 — CI boundary rule.** `import { ... } from 'mongodb'` is forbidden outside `packages/db`.

**C6 — Adversarial isolation test suite.** Two seeded workspaces; every repository method is
exercised with a deliberately wrong workspace ID and must return empty / throw. This suite runs on
every commit and is the acceptance evidence for **AC-10**.

**C7 — Atlas-level separation.** Distinct database users per environment; the `app` user has no
`dropDatabase` privilege and **no update/delete on `auditLog`**; migrations run under a separate
user.

---

## 5. Credential security

- **Envelope encryption.** Per-credential random DEK → AES-256-GCM over plaintext → DEK wrapped by
  a workspace KEK → KEK held behind the `KeyProvider` port (`LocalFileKeyProvider` dev,
  `EnvKeyProvider` on Vercel Phase 1; `KmsKeyProvider` / `VaultKeyProvider` stubbed). `keyProvider`
  and `kekVersion` are per-document, so rotation is incremental and online.
- **Plaintext never leaves the resolution boundary.** `CredentialResolver` returns a short-lived,
  non-serialisable handle. Secrets never appear in `runs`, `runSteps`, `runEvents`, `auditLog`,
  logs, traces, or LLM context.
- **Redaction at write time**, not at display time: `runSteps.toolCalls[].argumentsRedacted` is
  produced by schema-driven rules (fields whose schema or name marks them sensitive) plus an
  entropy heuristic for anything that looks like a token.
- **Two disjoint credential domains.** MCP servers never receive AI-provider credentials; AI
  providers never receive MCP credentials. Neither ever reaches the browser.
- **Deferred, tracked:** MongoDB **Queryable Encryption / CSFLE** would make ciphertext opaque to
  the database itself. Not Phase 1 — it would couple the `KeyProvider` port to Atlas. Phase 6 item.

### 5.1 MCP OAuth (aligned to the 2026-07-28 authorization spec)

- MCP servers are OAuth 2.1 **resource servers**; we discover the authorization server via
  **RFC 9728** Protected Resource Metadata.
- **RFC 8707 Resource Indicators** on every token request, naming the exact MCP server. A token
  minted for server A cannot be replayed against server B.
- **RFC 9207** issuer validation on every authorization response (AS mix-up defence); client
  credentials are bound to the issuer that minted them.
- **CIMD** (Client ID Metadata Documents) is the primary onboarding path — we host a metadata
  document at a stable HTTPS URL and use that URL as our `client_id`. **DCR is deprecated upstream**
  and retained only as a fallback for servers that have not migrated.
- PKCE on every flow. Per-user connections (`perUserAuth: true`) are the default for user-facing
  servers, so one user's consent never grants another user access.

---

## 6. MCP-specific threat model

These are the threats that are specific to being an MCP **host**, and they are the reason the
capability layer is permission-gated rather than trusted.

### 6.1 Prompt injection via tool results (R1 — the central threat)

A tool returns attacker-controlled text that instructs the model to call another tool.

**Controls (defence in depth, no single one is sufficient):**
1. Tool results are **structurally framed as untrusted data** in the assembled context, never as
   instructions.
2. Destructive capabilities require `ask` regardless of what any text says — the model cannot talk
   its way past the `PermissionBroker`, because the broker never reads the model's reasoning.
3. `trustTier` gates chaining: a `community`/`untrusted` server's output cannot trigger a
   non-read-only capability without approval in the same turn.
4. Per-run tool-call caps and loop detection bound the blast radius.
5. Every chain is fully audited with arguments and decisions.
6. An adversarial corpus runs in CI from Phase 1 (small in Phase 1, expanded in Phase 6).

### 6.2 Tool-definition rug pull (R2)

A server changes a tool's schema or description *after* approval. Descriptions enter the model's
context, so this is an injection surface as well as a capability change.

**Control:** `definitionHash` and `approval.definitionHash` live in the **same document**
(`DATA-MODEL.md` §5.3). Discovery updates both in one atomic write, so approval self-invalidates.
There is no window in which a changed tool remains approved, and no cross-document race. The UI
shows a **diff** before re-approval.

### 6.3 Server-requested inference via MRTR (R3)

MRTR replaces the deprecated `sampling` capability. A server can return `input_required` asking the
*client* to perform inference.

**Control: denied by default.** Enabling it per binding is an explicit opt-in that runs under a
hard sub-budget, is charged to the workspace, and is fully audited. An MCP server must never get
free, unbounded, unattributed access to our models. `requestState` is treated as fully opaque —
echoed verbatim, never parsed, never logged in full.

### 6.4 stdio as arbitrary code execution (R6)

Not in Phase 1. When introduced (Phase 3): first-party and verified servers only in the hosted
tier, each in a container sandbox with read-only rootfs, no ambient credentials (env injected per
invocation), egress allowlist, and CPU/memory/PID caps. Third-party servers use Streamable HTTP.

### 6.5 Confused-deputy across bindings

An agent with access to two bindings could be induced to move data from one to the other.

**Control:** per-binding policy scoping, per-user OAuth so cross-user data is not reachable in the
first place, and audit trails that make the chain reconstructable. Cross-binding data-flow policy
is a tracked Phase 6 item, not claimed as solved in Phase 1.

---

## 7. Risk register

| # | Risk | Severity | Mitigation | Phase |
|---|---|---|---|---|
| **R1** | Prompt injection via tool results | Critical | §6.1 — untrusted framing, `ask` on destructive, trust-tier chaining, caps, audit, CI corpus | 1 (base) / 6 (deep) |
| **R2** | Tool-definition rug pull | Critical | §6.2 — same-document hash + approval, atomic invalidation, diff UI | 1 |
| **R3** | Unbounded server-requested inference | High | §6.3 — denied by default, opt-in, sub-budget, audited | 1 |
| **R4** | **Cross-tenant leakage (no RLS on MongoDB)** | Critical | §4 — C1–C7, especially the command-monitoring guard and the adversarial isolation suite | 1 |
| **R5** | Provider abstraction leakage into the runtime | High | `no-provider-branching` lint, `dependency-cruiser`, conformance suite, **three adapters from Phase 1** | 1 |
| **R6** | stdio = arbitrary code execution | High | §6.4 — excluded from Phase 1; sandboxed and tier-gated in Phase 3 | 3 |
| **R7** | Runaway cost / infinite tool loops | High | Runtime-enforced `RunBudget`, daily workspace cost cap, loop detection, per-agent kill switch | 1 |
| **R8** | Context window exhaustion | Medium | Compaction with explicit summary messages; never silent truncation | 1 |
| **R9** | Silent prompt-cache invalidation | Medium | Cache-stable `ContextAssembler` + CI prefix-stability test; cache-hit-rate alert | 1 |
| **R10** | MCP spec churn | Medium | All protocol contact confined to `packages/mcp`; SDK version negotiation `auto`; negotiated version recorded per binding | 1 |
| **R11** | OAuth token custody across many bindings | High | RFC 8707 resource indicators, envelope encryption, short-lived access tokens, revocation cascade | 1 |
| **R12** | Serverless duplicate execution of a run | High | Atomic lease claim; **every write guarded by `lease.token`** | 1 |
| **R13** | Mongo connection exhaustion under Fluid compute | Medium | Cached `MongoClient` on `globalThis`, low `maxPoolSize`, churn metric + alert | 1 |
| **R14** | Approval fatigue → "allow everything" | Medium | Risk-tiered defaults from `trustTier` + annotations-as-floor; scoped remembered decisions; read-only tools default `allow` for verified servers | 1 (base) / 3 (full) |
| **R15** | Vector search bypassing tenant filter | Critical | §4 C3 — `workspaceId` as an indexed `filter` field inside `$vectorSearch`; enforced by the wrapper | 2 |
| **R16** | Atlas network exposure where private endpoints are unavailable | Medium | Private endpoint / peering where the plan allows; otherwise documented accepted risk with strong auth, TLS, and per-environment users | 1 |
| **R17** | Embedded `members[]` contention / 500-member cap | Low | Targeted `$push`/`$pull` with arrayFilters; documented migration to a separate collection behind the same repository interface | 1 (documented) |

---

## 8. Auditability

Every one of the following writes an `auditLog` entry with actor, subject, action and metadata:

- authentication events (login, logout, 2FA change, password reset, session revocation)
- workspace membership and role changes
- credential create / rotate / revoke / **resolve** (that a secret was read, never its value)
- MCP binding install, OAuth grant, capability approval / re-approval / revocation
- every permission decision (`allow`, `ask`, `deny`) with the matched rule
- every tool invocation with redacted arguments and outcome
- policy changes
- run cancellation and budget overrides

The application database user has **no `update` or `delete` privilege** on `auditLog`. Entries are
append-only by grant, not by convention.
