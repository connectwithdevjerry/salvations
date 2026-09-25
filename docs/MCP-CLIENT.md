# MCP Client Architecture

Companion to [../ARCHITECTURE.md](../ARCHITECTURE.md).

Aligned to MCP specification revision **`2026-07-28`** and the official TypeScript SDK **V2**.
`packages/mcp` is the **only** package permitted to import `@modelcontextprotocol/client`.

---

## 1. Position in the system

MCP is the **capability layer** — the sole route from the Agent Runtime to anything outside itself.

Two consequences stated up front:

- **We are the MCP client.** Provider-hosted MCP connectors exist (e.g. passing server URLs to an
  inference API and letting the provider call them). We deliberately do not use them: that
  relocates the capability layer inside one vendor's inference API and forfeits tool-level
  permissions, approval gating, audit, and provider independence in one move. MCP must be
  independent of the provider (requirement 10), and a provider-hosted connector is the opposite.
- **Channels are not MCP.** Telegram-as-a-*channel* (a UI) and Telegram-as-an-*MCP server* (a
  capability an agent can call) are different things that happen to share a name. Conflating them
  is the hard-coded-integration mistake this architecture exists to prevent.

---

## 2. Specification alignment (verified 2026-09-15)

The `2026-07-28` revision is a rewrite, not an increment. What it changes for a *client*:

| Change | Client impact |
|---|---|
| **Stateless protocol core** — `initialize`/`initialized` and `Mcp-Session-Id` removed; per-request `_meta` envelope (e.g. `_meta["io.modelcontextprotocol/clientInfo"]`) + `MCP-Protocol-Version` header | A remote MCP server is **not** a stateful session. Connection "pooling" collapses to HTTP keep-alive + a token cache |
| **`server/discover`** replaces the handshake | Discovery is an explicit call, not a connect side effect |
| **`Mcp-Method` / `Mcp-Name` headers** required; servers reject header/body disagreement | Any proxy we own must preserve them verbatim |
| **`ttlMs` / `cacheScope`** on list + read results | Discovery caching is spec-driven. **`cacheScope` is a tenancy-safety signal**, not a perf hint |
| **Multi-Round-Trip Requests** replace server-initiated `sampling` / `elicitation` | Human-in-the-loop becomes a *resumable runtime loop* instead of a reverse-RPC channel |
| **Roots, Sampling, Logging deprecated** (12-month window) | Not used |
| **Tasks moved to an extension**, poll-based (`tasks/get`, `tasks/update`, `tasks/cancel`); breaking vs the 2025-11-25 experimental API | Long-running tools map to our run-suspension machinery |
| **JSON Schema 2020-12**; `outputSchema` unrestricted; `structuredContent` may be any JSON value | Validator must be Ajv **2020**; result handling must accept non-object JSON |
| **Subscriptions** move to `subscriptions/listen`, opt-in per notification type | Optional for us — `ttlMs` covers Phase 1 |
| **HTTP+SSE transport deprecated** (12-month off-ramp) | Never implemented |
| **Authorization**: OAuth 2.1 resource servers, RFC 9728 discovery, RFC 8707 resource indicators, RFC 9207 issuer validation, **DCR deprecated in favour of CIMD** | See `SECURITY.md` §5.1 |

### 2.1 SDK and transport decision

| Package | Version | Role |
|---|---|---|
| `@modelcontextprotocol/client` | **2.0.0** (published 2026-07-28) | our client |
| `@modelcontextprotocol/server` | 2.0.0 | first-party servers (Phase 5) |
| `@modelcontextprotocol/sdk` | 1.30.0 | **legacy monolith — not used** |

TypeScript is a **Tier 1** SDK for this revision, which is a first-order reason the host is built
in TypeScript.

**Version negotiation.** The V2 `Client` speaks both eras — legacy (`2024-10-07` … `2025-11-25`,
`initialize`) and modern (`2026-07-28`, `server/discover` + `_meta`) — via a `versionNegotiation`
option: default `legacy`, `auto` (probe then fall back), or pinned (`{ pin: '2026-07-28' }`).

> **Policy:** `auto` per binding. Persist the result on
> `mcpServerBindings.negotiatedProtocolVersion` and surface it in the UI, so operators can see
> which of their servers are still legacy. A per-binding pin is available for servers that
> misbehave under probing.

**Transports.**
- **Streamable HTTP** — the default, and the **only** transport in Phase 1.
- **stdio** — Phase 3, sandboxed, first-party/verified tiers only (`SECURITY.md` §6.4).
- **HTTP+SSE** — never. Deprecated upstream.

---

## 3. Components

```
McpServerRegistry       binding → server definition + auth policy
McpConnectionFactory    transport for (binding, ConnectionScopeKey)
McpClientManager        lifecycle, concurrency limits, circuit breaking, health
CapabilityDiscovery     server/discover + */list; ttlMs + cacheScope-aware caching
CapabilityStore         normalise, definitionHash, diff, atomic approval invalidation
ToolGateway             the ONLY runtime → MCP path: permit → validate → invoke → audit
McpOAuthClient          RFC 9728 · PKCE · CIMD client_id · RFC 8707 resource · RFC 9207 issuer
McpTaskPoller           tasks/get polling → run resumption            (Phase 3)
McpSubscriptionManager  subscriptions/listen opt-in                   (Phase 3)
```

---

## 4. Connection model

Because the protocol core is stateless, the connection model is genuinely simple — the spec did us
a favour here.

**Streamable HTTP:** there is no session to pool. We maintain an HTTP agent with keep-alive, a
per-scope token cache, a per-binding concurrency semaphore, and a circuit breaker fed by
`mcpServerBindings.health`. Any server replica may serve any request, which is precisely what the
stateless redesign intended — and it is what makes MCP calls work cleanly from short-lived
serverless functions.

```ts
type ConnectionScopeKey =
  | { kind: 'workspace'; bindingId: string }
  | { kind: 'user';      bindingId: string; userId: string };   // perUserAuth = true
```

The scope key is part of **every** cache key, **every** token lookup, and **every** pooled resource.
Mixing scopes is the cross-tenant bug (`SECURITY.md` R4), so it is made structurally impossible via
the type rather than discouraged by convention.

---

## 5. Dynamic capability discovery

```
1. Cache lookup keyed by (bindingId, scopeKey, kind), honouring ttlMs
     cacheScope decides SHAREABILITY:
       shareable across users  → cache under the workspace scope key
       otherwise               → cache under the user scope key, NEVER shared
     absent / unrecognised cacheScope → treated as NON-shareable.  FAIL CLOSED.

2. On miss:  server/discover  →  tools/list  (resources/list, prompts/list in Phase 3)
     versionNegotiation: 'auto'

3. Normalise each capability; compute definitionHash = sha256(normalised definition)

4. Diff against mcpCapabilities:
     new        → insert with approval.state = 'pending'
     changed    → update definitionHash in the SAME write that invalidates approval
     missing    → set removedAt (soft delete — history must stay explainable)

5. Emit workspace events so the UI reflects reality without a refresh
```

### 5.1 Rug-pull defence is a field comparison, not a workflow

`definitionHash` and `approval.definitionHash` live in the **same document**
(`DATA-MODEL.md` §5.3):

```
isUsable(cap)  ===  cap.approval.state === 'approved'
               &&   cap.approval.definitionHash === cap.definitionHash
```

Because both fields update in one atomic write, there is **no window** in which a changed tool is
still approved, and no cross-document race to reason about. The UI shows a diff before re-approval.

Discovery runs on: binding creation, manual refresh, `ttlMs` expiry, a `subscriptions/listen`
notification (Phase 3), and a periodic reconciliation sweep.

---

## 6. Capability namespacing

Collisions are inevitable — three servers, three `search` tools.

```
canonical:  <bindingAlias>__<capabilityName>        e.g.  linear__create_issue
```

`mcpServerBindings.alias` is unique per workspace (`{ workspaceId, alias }` unique index), so
canonical names are unique **by construction**, not by a collision-resolution pass.

Providers impose stricter limits (commonly `^[a-zA-Z0-9_-]{1,64}$`). The **provider adapter** —
not the MCP layer — applies a deterministic transform: slugify → truncate → append a short hash of
the full canonical name, keeping a per-request reverse map. The hash suffix guarantees truncation
can never create a collision.

---

## 7. Invocation — `ToolGateway`

The runtime **cannot reach an MCP server except through `ToolGateway`.** There is no second path,
no "internal" bypass, and no exemption for platform-owned servers.

```
ToolGateway.invoke(canonicalName, args, ctx):

  1. Resolve  alias__tool → (binding, capability)         — unknown name ⇒ tool error, not a throw
  2. PermissionBroker.decide()                            — SECURITY.md §3.3
       deny → synthesise an is_error tool_result explaining the denial
              (the model must LEARN it was denied, not silently receive nothing)
       ask  → persist an approvals doc, SUSPEND the run as waiting_approval, return
  3. Validate arguments against inputSchema with Ajv 2020-12   — failure ⇒ is_error result
  4. Acquire per-binding concurrency slot + rate-limit token
  5. McpClientManager.callTool()
  6. Handle result:
       a. normal           → normalise content + structuredContent (any JSON value)
       b. input_required   → MRTR loop (§8)
       c. task handle      → register poll job, SUSPEND run as waiting_tool   (Phase 3)
  7. Cap result size; spill oversized payloads to the blob store, pass a reference
  8. Write runSteps.toolCalls[] + auditLog
```

**Denial is a tool result, not an exception.** An agent that receives nothing will retry; an agent
told "denied by policy: rule X" will adapt or explain. This matters for behaviour quality as much
as for safety.

**All** tool results for one assistant turn are returned in a **single** tool message. Splitting
them across messages teaches models to stop making parallel calls — a subtle, permanent quality
regression that is very hard to diagnose later.

---

## 8. Multi-Round-Trip Requests

MRTR replaces deprecated server-initiated sampling and elicitation, and it is where a lot of the
security sits.

```
callTool(args)
  └─ result.resultType === 'input_required'
       ├─ classify each inputRequest:
       │    'auto'      → policy can answer it (a known confirmation shape)
       │    'human'     → SUSPEND run (waiting_input); create an approval;
       │                  ask via the channel; resume on decision
       │    'inference' → the server wants US to run a model for it
       │
       ├─ 🔒 POLICY GATE for 'inference': this is the old `sampling` capability wearing a
       │    new hat. DENIED BY DEFAULT. Enabling it per binding is an explicit opt-in that
       │    runs under a hard sub-budget, is charged to the workspace, and is fully audited.
       │    An MCP server must never get free, unbounded, unattributed access to our models.
       │
       └─ retry the original call with { inputResponses, requestState } echoed verbatim
            requestState is OPAQUE — never parsed, never modified, never logged in full
  └─ bounded by budget.maxMrtrRounds (default 4)
```

Because `waiting_input` is a persisted run state, a human can answer an MCP server's question
**minutes or hours later** and the run resumes correctly — on Vercel, in a worker, or across a
deployment. The stateless protocol and our resumable runtime compose well here.

---

## 9. Serverless considerations

MCP calls originate from short-lived Vercel functions in Phase 1. This works *because* the protocol
is now stateless:

- No session to establish, so no per-invocation handshake cost.
- Discovery results are cached in MongoDB (scope-keyed), not in process memory, so a cold start
  does not re-discover.
- OAuth tokens live in `credentials` / `oauthConnections`, not in memory.
- **Per-tool-call timeout must be shorter than the executor's `RESERVE_MS`** (`DEPLOYMENT.md` §3.1),
  so a slow tool cannot strand a slice mid-step. Anything genuinely long-running belongs in the
  Tasks extension (Phase 3), which suspends rather than blocks.

---

## 10. First-party MCP servers (Phase 5 — explicitly not Phase 1)

Requirement 14 excludes custom MCP server creation from Phase 1. When it arrives, first-party
capabilities (memory search, document retrieval, workspace admin, sub-agent spawning) are built as
**real MCP servers** using `@modelcontextprotocol/server`, not as runtime built-ins.

This is a deliberate dogfooding constraint: if our own capabilities need a back door through
`ToolGateway`, the abstraction is wrong and we find out immediately rather than in month nine. An
in-process transport is permitted as a latency optimisation, but it implements the same client
interface and passes the same permission and audit path.
