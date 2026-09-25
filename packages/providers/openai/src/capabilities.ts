/**
 * Model capability descriptors for this vendor.
 *
 * Same job as every other adapter's: express the differences as data so the
 * runtime never asks which vendor it is talking to.
 */
import type { ModelCapabilities } from '@salvations/core';

const TOOL_NAME_PATTERN = '^[a-zA-Z0-9_-]{1,64}$';
const TOOL_NAME_MAX = 64;

interface ModelProfile {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
}

const PROFILES: Readonly<Record<string, ModelProfile>> = {
  'gpt-5.6-sol': { maxInputTokens: 400_000, maxOutputTokens: 128_000, reasoning: true },
  'gpt-5': { maxInputTokens: 400_000, maxOutputTokens: 128_000, reasoning: true },
  'gpt-4.1': { maxInputTokens: 1_000_000, maxOutputTokens: 32_768, reasoning: false },
  'gpt-4o': { maxInputTokens: 128_000, maxOutputTokens: 16_384, reasoning: false },
  /*
   * Models that never see a chat turn. Listed so the catalogue can offer them
   * for the transcription and embedding roles — the adapter knows them, which
   * is what the catalogue test checks — with a profile that would only matter
   * if somebody bound one to chat by mistake, in which case a tight window is
   * the safer error.
   */
  'gpt-4o-transcribe': { maxInputTokens: 16_000, maxOutputTokens: 2_000, reasoning: false },
  'gpt-4o-mini-transcribe': { maxInputTokens: 16_000, maxOutputTokens: 2_000, reasoning: false },
  'whisper-1': { maxInputTokens: 16_000, maxOutputTokens: 2_000, reasoning: false },
  'text-embedding-3-small': { maxInputTokens: 8_192, maxOutputTokens: 1, reasoning: false },
  'text-embedding-3-large': { maxInputTokens: 8_192, maxOutputTokens: 1, reasoning: false },
};

const FALLBACK: ModelProfile = {
  maxInputTokens: 128_000, maxOutputTokens: 16_384, reasoning: false,
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
      jsonSchemaDialect: '2020-12',
      strictMode: true,
    },

    reasoning: {
      supported: profile.reasoning,
      mode: profile.reasoning ? 'adaptive' : 'none',
      ...(profile.reasoning ? { effortLevels: ['low', 'medium', 'high'] as const } : {}),
      // This transport does not surface reasoning state at all, so there is
      // nothing to replay. Declaring false is honest; declaring true and
      // fabricating an artifact would corrupt a continuation.
      artifactsMustReplay: false,
      artifactsPortable: false,
    },

    promptCache: {
      supported: true,
      // Caching here is applied automatically on a matching prefix rather than
      // marked explicitly, so the runtime places no breakpoints.
      strategy: 'automatic',
    },

    structuredOutput: { supported: true, mechanism: 'response_format' },
    modalities: { imageInput: true, documentInput: false, audioInput: false },
    assistantPrefill: false,
    // System arrives as the first message rather than a top-level field.
    systemMessagePlacement: 'first_message',
    streaming: true,
  };
}

export const knownModels = (): readonly string[] => Object.keys(PROFILES);
