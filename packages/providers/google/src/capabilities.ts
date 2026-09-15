import type { ModelCapabilities } from '@salvations/core';

/** This vendor accepts a narrower name shape than the others. */
const TOOL_NAME_PATTERN = '^[a-zA-Z_][a-zA-Z0-9_]{0,62}$';
const TOOL_NAME_MAX = 63;

interface ModelProfile {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
}

const PROFILES: Readonly<Record<string, ModelProfile>> = {
  'gemini-3.1-pro-preview': { maxInputTokens: 2_000_000, maxOutputTokens: 64_000, reasoning: true },
  'gemini-3-pro': { maxInputTokens: 2_000_000, maxOutputTokens: 64_000, reasoning: true },
  'gemini-2.5-pro': { maxInputTokens: 1_000_000, maxOutputTokens: 64_000, reasoning: true },
  'gemini-2.5-flash': { maxInputTokens: 1_000_000, maxOutputTokens: 64_000, reasoning: true },
};

const FALLBACK: ModelProfile = {
  maxInputTokens: 1_000_000, maxOutputTokens: 8_192, reasoning: false,
};

export function capabilitiesFor(modelId: string): ModelCapabilities {
  const profile = PROFILES[modelId] ?? FALLBACK;

  return {
    modelId,
    maxInputTokens: profile.maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens,

    tools: {
      supported: true,
      parallelCalls: true,
      forcedChoice: true,
      namePattern: TOOL_NAME_PATTERN,
      maxNameLength: TOOL_NAME_MAX,
      // Function parameters accept a restricted schema subset, so composition
      // keywords are down-converted rather than sent through.
      jsonSchemaDialect: 'draft-07',
      strictMode: false,
    },

    reasoning: {
      supported: profile.reasoning,
      mode: profile.reasoning ? 'adaptive' : 'none',
      // Thought parts are summaries, not signed opaque state, so there is
      // nothing that must be replayed verbatim.
      artifactsMustReplay: false,
      artifactsPortable: false,
    },

    promptCache: { supported: true, strategy: 'automatic' },
    structuredOutput: { supported: true, mechanism: 'response_format' },
    modalities: { imageInput: true, documentInput: true, audioInput: true },
    assistantPrefill: false,
    // Carried in its own top-level field rather than as a message.
    systemMessagePlacement: 'top_level',
    streaming: true,
  };
}

export const knownModels = (): readonly string[] => Object.keys(PROFILES);
