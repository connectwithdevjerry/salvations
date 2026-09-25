import { runConformanceSuite, type ConformanceTarget, type RequestInspector } from '@salvations/provider-testkit';
import { asProviderType } from '@salvations/core';
import { createProvider } from './index';
import * as fixtures from './fixtures';

type Body = Record<string, unknown> | undefined;
type WireMessage = { role?: string; content?: string; tool_calls?: unknown[] };

const messagesOf = (body: Body): WireMessage[] =>
  ((body?.['messages'] ?? []) as WireMessage[]);

const inspect: RequestInspector = {
  // System is a message on this transport, so it is excluded to keep the
  // suite's count comparable across vendors.
  messageCount: (body) => messagesOf(body as Body).filter((m) => m.role !== 'system').length,

  // Reasoning state is never carried here, so nothing is ever replayed. The
  // suite reads the declared capability and asserts accordingly.
  replayedArtifact: () => false,

  toolNames: (body) =>
    (((body as Body)?.['tools'] ?? []) as { function: { name: string } }[])
      .map((t) => t.function.name),

  systemText: (body) =>
    messagesOf(body as Body).filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n'),

  isStreaming: (body) => (body as Body)?.['stream'] === true,
};

const target: ConformanceTarget = {
  providerType: asProviderType('openai'),
  modelId: 'gpt-5.6-sol',
  create: (fetchImpl) =>
    createProvider({
      apiKey: 'test-key-not-real',
      baseUrl: 'https://provider.invalid/v1',
      fetch: fetchImpl as typeof globalThis.fetch,
      defaultModel: 'gpt-5.6-sol',
    }),
  inspect,
  scenarios: {
    text: fixtures.textStream,
    singleToolCall: fixtures.singleToolCall,
    parallelToolCalls: fixtures.parallelToolCalls,
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
