# Provider Abstraction — `AgentProvider`

Companion to [../ARCHITECTURE.md](../ARCHITECTURE.md).

This is the seam that decides whether "the AI provider is replaceable" is a real property or a
slogan. Requirement 11 — *one conversation continuing across Anthropic, OpenAI and Google with
correct handling of provider-specific artifacts* — is the acceptance test for this entire document.

---

## 1. The rule

**The Agent Runtime never names a provider.** Not in a conditional, not in an import, not in a
config lookup. Provider differences are expressed two ways and only two ways:

1. **As data** — a `ModelCapabilities` descriptor the runtime *reads*.
2. **As behaviour** — inside an adapter the runtime cannot see.

```ts
// GOOD — capability-driven, lives in packages/runtime
if (caps.promptCache.strategy === 'explicit_breakpoints') {
  plan.cacheBreakpoints = chooseBreakpoints(ctx, caps.promptCache.maxBreakpoints ?? 4);
}

// FORBIDDEN — fails the CI lint rule `no-provider-branching`
if (providerType === 'anthropic') { /* ... */ }
```

Enforced by: a custom ESLint rule, a `dependency-cruiser` rule forbidding
`packages/runtime → packages/providers/*`, and a CI grep gate over `packages/core` and
`packages/runtime` (**AC-12**).

---

## 2. The port

```ts
// packages/core/src/ports/agent-provider.ts
// No SDK import is permitted in this file. Ever.

export interface AgentProvider {
  readonly providerType: ProviderType;

  /** Static + live capability descriptor; cached in modelBindings.capabilities. */
  describeModel(modelId: string): Promise<ModelCapabilities>;

  /** The single inference entry point. ALWAYS streaming — non-streaming is a fold over this. */
  generate(req: GenerationRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;

  countTokens?(req: GenerationRequest): Promise<TokenCount>;
  embed?(req: EmbeddingRequest): Promise<EmbeddingResult>;   // Phase 2
}
```

Streaming is the *only* mode because a non-streaming API can always be built from a stream, but not
the reverse — and because on Vercel a long non-streaming call is indistinguishable from a hang.

---

## 3. `ModelCapabilities` — differences as data

```ts
interface ModelCapabilities {
  modelId: string;
  maxInputTokens: number;
  maxOutputTokens: number;

  tools: {
    supported: boolean;
    parallelCalls: boolean;
    forcedChoice: boolean;              // some current models reject forced tool_choice
    maxTools?: number;
    namePattern: string;                // e.g. "^[a-zA-Z0-9_-]{1,64}$"
    maxNameLength: number;
    jsonSchemaDialect: 'draft-07' | '2020-12';
    strictMode: boolean;
  };

  reasoning: {
    supported: boolean;
    mode: 'none' | 'budget' | 'adaptive' | 'always_on';
    effortLevels?: string[];            // e.g. ['low','medium','high','xhigh','max']
    artifactsMustReplay: boolean;       // same-model continuation REQUIRES verbatim replay
    artifactsPortable: boolean;         // almost always false — see §5
  };

  promptCache: {
    supported: boolean;
    strategy: 'explicit_breakpoints' | 'automatic' | 'none';
    maxBreakpoints?: number;
    minPrefixTokens?: number;
  };

  structuredOutput: { supported: boolean; mechanism: 'response_format' | 'output_config' | 'tool' };
  modalities:       { imageInput: boolean; documentInput: boolean; audioInput: boolean };
  assistantPrefill: boolean;            // removed on several current models
  systemMessagePlacement: 'top_level' | 'first_message' | 'inline_allowed';
  streaming: boolean;
}
```

Capabilities are fetched by the adapter, cached on `modelBindings.capabilities` with
`capabilitiesFetchedAt`, and refreshed on a TTL. A stale descriptor degrades gracefully; it never
produces a hard failure, because every consumer treats an absent capability as "not supported."

---

## 4. Canonical request and event types

```ts
interface GenerationRequest {
  system: SystemDirective[];            // ordered, cache-stable
  messages: CanonicalMessage[];
  tools: ToolDeclaration[];             // JSON Schema 2020-12, deterministically sorted
  toolChoice: 'auto' | 'none' | { name: string };
  maxOutputTokens: number;
  reasoning?: { effort?: EffortLevel; display?: 'omitted' | 'summarized' };
  cacheHints?: { breakpointsAfter: number[] };
  structuredOutput?: { schema: JsonSchema };
  stopSequences?: string[];
  metadata: { runId: string; workspaceId: string; agentId: string };
}

type ProviderEvent =
  | { type: 'start';            messageId: string }
  | { type: 'text_delta';       text: string }
  | { type: 'reasoning_delta';  text: string }
  | { type: 'tool_use_start';   id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }
  | { type: 'tool_use_end';     id: string; input: unknown }
  | { type: 'usage';            usage: Usage }     // incl. cacheRead / cacheWrite tokens
  | { type: 'finish';           reason: FinishReason; message: CanonicalMessage }
  | { type: 'error';            error: ProviderError };
```

`FinishReason` is normalised: `end_turn | tool_use | max_tokens | stop_sequence | content_filter |
refusal | error`. A provider-specific reason with no canonical equivalent maps to `error` with the
raw value preserved in `ProviderError.providerRaw`. **We never invent a successful outcome we do not
understand** — silently mapping an unknown terminal state to `end_turn` is how an agent platform
produces confidently truncated answers.

---

## 5. Provider-independent conversations (the critical design)

### 5.1 Canonical content

```ts
type ContentBlock =
  | { type: 'text';        text: string }
  | { type: 'image';       blobKey: string; mime: string }
  | { type: 'document';    blobKey: string; mime: string; title?: string }
  | { type: 'tool_use';    id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: ContentBlock[];
                           structured?: unknown; isError: boolean }
  | { type: 'reasoning';   summary?: string; redacted: boolean }
  | { type: 'blob_ref';    key: string; bytes: number; mime: string };
```

This is the **persistence format**. It is ours, and it is the reason a conversation outlives any
vendor relationship.

### 5.2 Opaque, model-keyed provider artifacts

Reasoning state cannot be canonicalised — it is signed, opaque, and provider-specific. So it is
stored **beside** the canonical content, keyed by the exact model that produced it:

```jsonc
// messages.providerArtifacts
{
  "anthropic:claude-opus-5": { "blocks": [ /* verbatim thinking blocks + signatures */ ] },
  "openai:<model>":          { "items":  [ /* verbatim reasoning items */ ] }
}
```

### 5.3 The replay rule

Enforced **in the adapter**, never in the runtime:

| Condition | Action |
|---|---|
| artifact key === current `provider:model` | replay **verbatim and unmodified** |
| different provider or different model | **drop** the artifact; send only canonical `reasoning` summaries |

This rule is not a nicety. Current Anthropic models require thinking blocks to be echoed back
unchanged when continuing on the same model, silently ignore blocks from a different model, and
newer models enforce an append-only history check that invalidates replayed thinking blocks if
earlier turns were edited. Encoding that as a per-adapter rule over an opaque, model-keyed sidecar
is what makes cross-provider continuation correct instead of corrupt — and it is precisely what a
naive "store the provider's JSON as the message" design makes impossible.

### 5.4 Two corollaries the runtime must honour

1. **History is append-only.** Compaction and edits produce *new* messages (summaries, tombstones
   via `supersededBy`), never in-place mutation of an existing message.
2. **Artifacts are never rendered as text.** They are wire-format payloads, not content. They never
   enter a prompt as a string, and never reach the browser.

---

## 6. Adapter responsibilities

Each adapter in `packages/providers/{anthropic,openai,google}` is the **only** place that knows:

| Responsibility | What it absorbs |
|---|---|
| Wire translation | canonical blocks ⇄ provider message shapes |
| Reasoning config | `effort` → the provider's mechanism (adaptive thinking + effort, reasoning effort, thinking config, …) |
| Cache translation | `cacheHints.breakpointsAfter` → explicit cache markers, or a no-op where caching is automatic |
| Schema down-conversion | JSON Schema 2020-12 → the dialect and subset the provider accepts; **reject-or-degrade is an explicit, logged decision**, never a silent drop of a constraint |
| Tool name normalisation | canonical `alias__tool` → provider-legal name within `namePattern`/`maxNameLength`, with a per-request reverse map (see `MCP-CLIENT.md` §6) |
| Artifact replay | §5.3 |
| Error normalisation | rate limit, overload, context length, content filter, refusal, auth → typed + `retryable` |
| Usage + cost | provider usage → canonical `Usage` including cache read/write; cost from `modelBindings.cost` |
| Streaming | provider chunk protocol → `ProviderEvent` |
| Prefill absence | models that reject assistant prefill — the canonical format has no prefill concept at all |

### 6.1 Verified provider facts baked in (as of 2026-09-15)

Recorded so adapters encode current reality rather than a stale prior:

- **Anthropic** current model IDs: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`,
  `claude-fable-5-1`. Exact strings, never date-suffixed.
- Anthropic reasoning is `thinking: { type: 'adaptive' }`; `budget_tokens` is **rejected with 400**
  on current models. Depth is `output_config.effort` (`low` … `max`).
- Assistant **prefill is removed** on current Anthropic models (400). Output shaping uses structured
  outputs or system instructions.
- Anthropic prompt caching is **prefix-match** with a small number of explicit breakpoints — which
  is why `ContextAssembler` must emit a byte-stable prefix.
- Anthropic's own **MCP connector** (`mcp_servers` + `mcp_toolset`) exists and is deliberately
  **not used** — see `MCP-CLIENT.md` §1.

These facts live in the Anthropic adapter and nowhere else. When they change, one file changes.

---

## 7. Conformance suite — the proof, not the claim

`packages/providers/testkit` is a **single shared suite** run against every adapter. It is written
*before* the first adapter, not after the third.

| Test group | What it pins |
|---|---|
| Golden conversations | canonical → wire → canonical round-trip fidelity |
| Tool round-trip | declaration, call, result, error result |
| Parallel tool calls | multiple `tool_use` in one turn; **all results returned in one tool message** |
| Streaming order | event sequence and delta accumulation invariants |
| Error taxonomy | each provider error maps to the right canonical type and `retryable` flag |
| Schema down-conversion | 2020-12 composition (`oneOf`/`$ref`/conditionals) degrades correctly and *loudly* |
| Name normalisation | long/colliding canonical names produce legal, unique, reversible names |
| **Artifact replay** | same-model → verbatim; cross-model → dropped |
| Capability honesty | declared `ModelCapabilities` match observed behaviour |
| Usage + cost | usage fields populated; cost computed from binding rates |

**A provider is not "supported" until it passes.** Adding a fourth provider must not require
touching `packages/runtime` — the suite is what proves that claim rather than asserting it.

---

## 8. Why three adapters in Phase 1

A two-provider abstraction always leaks: the second adapter gets shaped around the first, and the
leak only surfaces when the third arrives — usually months later, under deadline, which is when the
`if (provider === ...)` gets written.

Three adapters in the Phase 1 slice is a deliberate cost paid early to make the abstraction honest.
It is also directly what **AC-6** tests.

---

## 9. On the Vercel AI SDK (considered, deliberately not the core)

`ai` / `@ai-sdk/*` is a capable abstraction and Vercel is our deployment target, so it is the
obvious candidate. It is **not** the core `AgentProvider` port because:

- It would make our most vendor-sensitive seam depend on a third party's model of what a message
  is. Our canonical format is a **persistence format**, and persistence formats must be ours —
  a change in their message shape would be a data migration for us.
- It does not model what this runtime specifically needs: model-keyed artifact replay rules,
  prompt-cache breakpoint budgets, per-provider schema down-conversion, and a capability descriptor
  the runtime can branch on.
- Using it for provider access would also tempt us toward AI Gateway for model routing, which
  re-centralises the vendor relationship we are explicitly designing away from.

It stays a perfectly reasonable **implementation of a single adapter** later
(`packages/providers/aisdk`) to reach long-tail providers cheaply. The port makes that a one-file
decision instead of a rewrite. That is the point of having a port.
