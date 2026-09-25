/**
 * The conformance contract.
 *
 * Written BEFORE the first adapter, deliberately. An abstraction validated
 * after the fact gets shaped around whichever vendor was implemented first, and
 * the leak only surfaces when the third arrives — usually under deadline, which
 * is when `if (provider === ...)` gets written.
 *
 * Adapters are exercised through an injected `fetch`, so the suite drives each
 * vendor's REAL SDK parsing with canned bytes. Testing exported helper
 * functions instead would prove the helpers work while saying nothing about the
 * code path that actually runs in production.
 */
import type {
  AgentProvider, GenerationRequest, ModelCapabilities, ProviderError, ProviderType,
} from '@salvations/core';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A request the adapter sent, captured for assertions. */
export interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * Canonical facts extracted from a vendor's own wire request.
 *
 * Wire shapes differ, so each adapter reads its own; the ASSERTIONS stay shared.
 * This is the seam that lets one suite make identical claims about all three.
 */
export interface RequestInspector {
  /** Number of conversation turns the adapter sent. */
  messageCount(body: unknown): number;
  /** Whether opaque reasoning state for this model key was replayed. */
  replayedArtifact(body: unknown, providerKey: string): boolean;
  /** Tool names as the adapter named them on the wire. */
  toolNames(body: unknown): string[];
  /** The system text the adapter sent, however that vendor carries it. */
  systemText(body: unknown): string;
  /** Whether the adapter asked for streaming. */
  isStreaming(body: unknown): boolean;
}

/** Canned wire responses for each scenario the suite exercises. */
export interface WireScenarios {
  /** A plain text completion, streamed. */
  readonly text: () => Response;
  /** A completion containing exactly one tool call. */
  readonly singleToolCall: () => Response;
  /** A completion containing two tool calls in one turn. */
  readonly parallelToolCalls: () => Response;
  /** A completion carrying opaque reasoning state to be stored as an artifact. */
  readonly withReasoning?: () => Response;
  /** A completion stopped by the output-token ceiling. */
  readonly maxTokens: () => Response;
  /** Transport-level failures, mapped to canonical errors. */
  readonly rateLimited: () => Response;
  readonly serverError: () => Response;
  readonly badRequest: () => Response;
  readonly authFailure: () => Response;
}

export interface ConformanceTarget {
  readonly providerType: ProviderType;
  readonly modelId: string;
  /** Builds the adapter with an injected fetch and dummy credentials. */
  create(fetchImpl: FetchLike): AgentProvider;
  readonly inspect: RequestInspector;
  readonly scenarios: WireScenarios;
  /** Expected text content of the `text` scenario, for exact assertions. */
  readonly expectedText: string;
  /** Tool name and input the `singleToolCall` scenario returns. */
  readonly expectedToolCall: { name: string; input: unknown };
  /**
   * A representative opaque reasoning payload for this vendor.
   *
   * Artifacts are opaque BY DESIGN, so the suite cannot invent one — it asserts
   * the replay RULE while the adapter supplies the shape the rule applies to.
   */
  readonly sampleArtifact: unknown;
}

/** Records every request and replies from a queue of scripted responses. */
export function scriptedFetch(responses: readonly (() => Response)[]): {
  fetch: FetchLike;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  let index = 0;

  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      // Credentials are never asserted on, and capturing them would put a
      // secret-shaped value into a test failure message.
      headers[key] = /authorization|api-key|^x-api/i.test(key) ? '[redacted]' : value;
    });

    let body: unknown;
    const raw = init?.body;
    if (typeof raw === 'string') {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }

    requests.push({ url, method: init?.method ?? 'GET', headers, body });

    const next = responses[index];
    index += 1;
    if (next === undefined) {
      throw new Error(
        `Adapter made ${index} request(s) but only ${responses.length} were scripted.`,
      );
    }
    return next();
  };

  return { fetch, requests };
}

/**
 * Builds an SSE response body.
 *
 * Each entry is ONE complete event (its own `event:`/`data:` lines). SSE
 * separates events with a BLANK line — joining with a single newline instead
 * merges everything into one event whose data lines concatenate into invalid
 * JSON, which surfaces as a parse error rather than as a format mistake.
 */
export const sse = (events: readonly string[], status = 200): Response =>
  new Response(`${events.join('\n\n')}\n\n`, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });

export const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A minimal, vendor-neutral request the suite can send to any adapter. */
export function baseRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    system: [{ kind: 'identity', text: 'You are a helpful assistant.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }],
    tools: [],
    toolChoice: 'auto',
    maxOutputTokens: 1024,
    metadata: {
      runId: 'run_conformance' as never,
      workspaceId: 'wks_conformance' as never,
      agentId: 'agt_conformance' as never,
    },
    ...overrides,
  };
}

export const expectCapabilityShape = (caps: ModelCapabilities): string[] => {
  const problems: string[] = [];
  if (caps.maxInputTokens <= 0) problems.push('maxInputTokens must be positive');
  if (caps.maxOutputTokens <= 0) problems.push('maxOutputTokens must be positive');
  if (caps.tools.maxNameLength <= 0) problems.push('tools.maxNameLength must be positive');
  try {
    new RegExp(caps.tools.namePattern);
  } catch {
    problems.push('tools.namePattern must be a valid regular expression');
  }
  if (caps.promptCache.strategy === 'explicit_breakpoints' && caps.promptCache.maxBreakpoints === undefined) {
    problems.push('explicit_breakpoints requires maxBreakpoints');
  }
  if (caps.reasoning.supported && caps.reasoning.mode === 'none') {
    problems.push('reasoning.supported contradicts reasoning.mode "none"');
  }
  return problems;
};

export type { ProviderError };
