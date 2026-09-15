/**
 * Model capability description and the canonical inference contract.
 *
 * Vendor differences are expressed as DATA here so the runtime can read them.
 * The runtime must never ask which vendor it is talking to — see
 * docs/PROVIDER-ABSTRACTION.md §1 and the `no-provider-branching` lint rule.
 */
import type { AgentId, RunId, WorkspaceId } from '../ids.js';
import type { CanonicalMessage, ContentBlock } from './conversation.js';

/**
 * An opaque adapter identifier.
 *
 * Deliberately NOT a union of known vendors: `packages/core` must not enumerate
 * them, or adding a vendor would mean editing the domain. The registry owns the
 * set of known values and validates them at the boundary.
 */
export type ProviderType = string & { readonly __providerType: unique symbol };
export const asProviderType = (raw: string): ProviderType => raw as ProviderType;

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ModelCapabilities {
  readonly modelId: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;

  readonly tools: {
    readonly supported: boolean;
    readonly parallelCalls: boolean;
    /** Some current models reject a forced tool choice outright. */
    readonly forcedChoice: boolean;
    readonly maxTools?: number;
    readonly namePattern: string;
    readonly maxNameLength: number;
    readonly jsonSchemaDialect: 'draft-07' | '2020-12';
    readonly strictMode: boolean;
  };

  readonly reasoning: {
    readonly supported: boolean;
    readonly mode: 'none' | 'budget' | 'adaptive' | 'always_on';
    readonly effortLevels?: readonly EffortLevel[];
    /** Same-model continuation requires echoing reasoning state back verbatim. */
    readonly artifactsMustReplay: boolean;
    /** Almost always false: reasoning state is model-bound. */
    readonly artifactsPortable: boolean;
  };

  readonly promptCache: {
    readonly supported: boolean;
    readonly strategy: 'explicit_breakpoints' | 'automatic' | 'none';
    readonly maxBreakpoints?: number;
    readonly minPrefixTokens?: number;
  };

  readonly structuredOutput: {
    readonly supported: boolean;
    readonly mechanism: 'response_format' | 'output_config' | 'tool' | 'none';
  };

  readonly modalities: {
    readonly imageInput: boolean;
    readonly documentInput: boolean;
    readonly audioInput: boolean;
  };

  /** Removed on several current models; the canonical format has no prefill concept. */
  readonly assistantPrefill: boolean;
  readonly systemMessagePlacement: 'top_level' | 'first_message' | 'inline_allowed';
  readonly streaming: boolean;
}

export interface SystemDirective {
  readonly kind: 'identity' | 'policy' | 'safety' | 'memory' | 'retrieval';
  readonly text: string;
}

export interface ToolDeclaration {
  /** Canonical `alias__tool`. Adapters map this to a vendor-legal name. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface GenerationRequest {
  readonly system: readonly SystemDirective[];
  readonly messages: readonly CanonicalMessage[];
  /** Deterministically sorted — tool order is part of the cacheable prefix. */
  readonly tools: readonly ToolDeclaration[];
  readonly toolChoice: 'auto' | 'none' | { readonly name: string };
  readonly maxOutputTokens: number;
  readonly reasoning?: { readonly effort?: EffortLevel; readonly display?: 'omitted' | 'summarized' };
  readonly cacheHints?: { readonly breakpointsAfter: readonly number[] };
  readonly structuredOutput?: { readonly schema: JsonSchema };
  readonly stopSequences?: readonly string[];
  readonly metadata: {
    readonly runId: RunId;
    readonly workspaceId: WorkspaceId;
    readonly agentId: AgentId;
  };
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const emptyUsage: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/**
 * Normalised terminal reasons.
 *
 * A vendor reason with no canonical equivalent maps to 'error' with the raw
 * value preserved. Mapping an unknown terminal state onto 'end_turn' is how an
 * agent platform produces confidently truncated answers.
 */
export type FinishReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'content_filter'
  | 'refusal'
  | 'error';

export type ProviderErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'context_length'
  | 'content_filter'
  | 'refusal'
  | 'authentication'
  | 'invalid_request'
  | 'transport'
  | 'unknown';

export interface ProviderError {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Preserved verbatim so an unmapped vendor signal is never silently lost. */
  readonly providerRaw?: unknown;
}

export type ProviderEvent =
  | { readonly type: 'start'; readonly messageId: string }
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | { readonly type: 'tool_use_start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_input_delta'; readonly id: string; readonly partialJson: string }
  | { readonly type: 'tool_use_end'; readonly id: string; readonly input: unknown }
  | { readonly type: 'usage'; readonly usage: Usage }
  | {
      readonly type: 'finish';
      readonly reason: FinishReason;
      readonly content: readonly ContentBlock[];
      readonly providerArtifacts?: Readonly<Record<string, unknown>>;
      readonly usage: Usage;
    }
  | { readonly type: 'error'; readonly error: ProviderError };

export interface TokenCount {
  readonly inputTokens: number;
}

export interface EmbeddingRequest {
  readonly modelId: string;
  readonly inputs: readonly string[];
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly dimensions: number;
  readonly usage: Usage;
}
