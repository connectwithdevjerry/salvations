import { runConformanceSuite, type ConformanceTarget, type RequestInspector } from '@salvations/provider-testkit';
import { asProviderType } from '@salvations/core';
import { createProvider } from './index';
import * as fixtures from './fixtures';

type Body = Record<string, unknown> | undefined;

const inspect: RequestInspector = {
  messageCount: (body) => ((body as Body)?.['contents'] as unknown[] | undefined)?.length ?? 0,

  // Reasoning summaries are not resumable state, so nothing is ever replayed;
  // the suite reads the declared capability and asserts accordingly.
  replayedArtifact: () => false,

  toolNames: (body) => {
    const tools = ((body as Body)?.['tools'] ?? []) as { functionDeclarations?: { name: string }[] }[];
    return tools.flatMap((t) => (t.functionDeclarations ?? []).map((f) => f.name));
  },

  systemText: (body) => {
    const system = (body as Body)?.['systemInstruction'] as { parts?: { text?: string }[] } | undefined;
    return (system?.parts ?? []).map((p) => p.text ?? '').join('\n');
  },

  // Streaming is requested by the endpoint (`alt=sse`) rather than a body flag,
  // so the adapter's use of a stream-capable path is what matters here.
  isStreaming: () => true,
};

const target: ConformanceTarget = {
  providerType: asProviderType('google'),
  modelId: 'gemini-3.1-pro-preview',
  create: (fetchImpl) =>
    createProvider({
      apiKey: 'test-key-not-real',
      baseUrl: 'https://provider.invalid/v1beta',
      fetch: fetchImpl as typeof globalThis.fetch,
      defaultModel: 'gemini-3.1-pro-preview',
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
