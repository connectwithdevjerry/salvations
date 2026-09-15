import { runConformanceSuite, type ConformanceTarget, type RequestInspector } from '@salvations/provider-testkit';
import { asProviderType } from '@salvations/core';
import { createProvider } from './index';
import * as fixtures from './fixtures';

type Body = Record<string, unknown> | undefined;

/**
 * Reads canonical facts out of this vendor's own request shape.
 *
 * Every other adapter supplies its own reader; the ASSERTIONS in the suite stay
 * identical. That is the seam that makes one suite meaningful for all three.
 */
const inspect: RequestInspector = {
  messageCount: (body) => ((body as Body)?.['messages'] as unknown[] | undefined)?.length ?? 0,

  replayedArtifact: (body, _providerKey) => {
    const messages = ((body as Body)?.['messages'] ?? []) as { content?: unknown[] }[];
    // Opaque reasoning replays as thinking blocks carried verbatim.
    return messages.some((m) =>
      (m.content ?? []).some(
        (b) => typeof b === 'object' && b !== null &&
          ['thinking', 'redacted_thinking'].includes(String((b as { type?: string }).type)),
      ),
    );
  },

  toolNames: (body) =>
    (((body as Body)?.['tools'] ?? []) as { name: string }[]).map((t) => t.name),

  systemText: (body) =>
    (((body as Body)?.['system'] ?? []) as { text?: string }[])
      .map((s) => s.text ?? '').join('\n'),

  isStreaming: (body) => (body as Body)?.['stream'] === true,
};

const target: ConformanceTarget = {
  providerType: asProviderType('anthropic'),
  modelId: 'claude-opus-5',
  create: (fetchImpl) =>
    createProvider({
      apiKey: 'test-key-not-real',
      baseUrl: 'https://provider.invalid',
      fetch: fetchImpl as typeof globalThis.fetch,
      defaultModel: 'claude-opus-5',
    }),
  inspect,
  scenarios: {
    text: fixtures.textStream,
    singleToolCall: fixtures.singleToolCall,
    parallelToolCalls: fixtures.parallelToolCalls,
    withReasoning: fixtures.withReasoning,
    maxTokens: fixtures.maxTokensStream,
    rateLimited: fixtures.rateLimited,
    serverError: fixtures.serverError,
    badRequest: fixtures.badRequest,
    authFailure: fixtures.authFailure,
  },
  expectedText: fixtures.EXPECTED_TEXT,
  expectedToolCall: fixtures.EXPECTED_TOOL,
  sampleArtifact: fixtures.SAMPLE_ARTIFACT,
};

runConformanceSuite(target);
