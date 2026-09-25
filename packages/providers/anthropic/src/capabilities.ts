/**
 * Model capability descriptors.
 *
 * These are the vendor differences the runtime reads as DATA. Keeping them here
 * — and nowhere else — is what lets packages/runtime stay free of vendor names.
 *
 * Cached rather than authoritative: the descriptor is refreshed onto
 * modelBindings.capabilities on a TTL, and an unknown model falls back to a
 * conservative profile instead of throwing, so a newly released model degrades
 * rather than breaks.
 */
import type { EffortLevel, ModelCapabilities } from '@salvations/core';

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Tool naming rules this vendor enforces. */
const TOOL_NAME_PATTERN = '^[a-zA-Z0-9_-]{1,64}$';
const TOOL_NAME_MAX = 64;

interface ModelProfile {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly reasoningMode: ModelCapabilities['reasoning']['mode'];
  /** Some models reject a forced tool choice outright. */
  readonly forcedToolChoice: boolean;
  readonly effortLevels: readonly EffortLevel[];
}

const PROFILES: Readonly<Record<string, ModelProfile>> = {
  'claude-opus-5': {
    maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
    reasoningMode: 'adaptive', forcedToolChoice: true, effortLevels: EFFORTS,
  },
  'claude-opus-4-8': {
    maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
    reasoningMode: 'adaptive', forcedToolChoice: true, effortLevels: EFFORTS,
  },
  'claude-sonnet-5': {
    maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
    reasoningMode: 'adaptive', forcedToolChoice: true, effortLevels: EFFORTS,
  },
  'claude-haiku-4-5': {
    maxInputTokens: 200_000, maxOutputTokens: 64_000,
    // This model still takes an explicit thinking budget rather than adapting.
    reasoningMode: 'budget', forcedToolChoice: true, effortLevels: [],
  },
  'claude-fable-5-1': {
    maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
    // Reasoning is always on and cannot be disabled.
    reasoningMode: 'always_on',
    // Forced tool choice returns 400 here — the runtime reads this rather than
    // discovering it as a request failure.
    forcedToolChoice: false,
    effortLevels: EFFORTS,
  },
};

const FALLBACK: ModelProfile = {
  maxInputTokens: 200_000, maxOutputTokens: 8_192,
  reasoningMode: 'none', forcedToolChoice: false, effortLevels: [],
};

export function capabilitiesFor(modelId: string): ModelCapabilities {
  const profile = PROFILES[modelId] ?? FALLBACK;
  const reasoningSupported = profile.reasoningMode !== 'none';

  return {
    modelId,
    maxInputTokens: profile.maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens,

    tools: {
      supported: true,
      parallelCalls: true,
      forcedChoice: profile.forcedToolChoice,
      namePattern: TOOL_NAME_PATTERN,
      maxNameLength: TOOL_NAME_MAX,
      jsonSchemaDialect: '2020-12',
      strictMode: true,
    },

    reasoning: {
      supported: reasoningSupported,
      mode: profile.reasoningMode,
      ...(profile.effortLevels.length > 0 ? { effortLevels: profile.effortLevels } : {}),
      // Reasoning state must be echoed back unchanged when continuing on the
      // same model, and is meaningless to any other — which is exactly why
      // artifacts are keyed by provider:model.
      artifactsMustReplay: reasoningSupported,
      artifactsPortable: false,
    },

    promptCache: {
      supported: true,
      // Prefix-match caching with a small number of explicit markers, which is
      // why ContextAssembler must emit a byte-stable prefix.
      strategy: 'explicit_breakpoints',
      maxBreakpoints: 4,
      minPrefixTokens: 1024,
    },

    structuredOutput: { supported: true, mechanism: 'output_config' },
    modalities: { imageInput: true, documentInput: true, audioInput: false },
    // Assistant prefill returns 400 on current models; the canonical format has
    // no prefill concept at all.
    assistantPrefill: false,
    systemMessagePlacement: 'top_level',
    streaming: true,
  };
}

export const knownModels = (): readonly string[] => Object.keys(PROFILES);
