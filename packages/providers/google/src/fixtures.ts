import { json, sse } from '@salvations/provider-testkit';

const chunk = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify({ responseId: 'resp_conformance', ...payload })}`;

const usage = (): Record<string, unknown> => ({
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 },
});

export const EXPECTED_TEXT = 'Hello there.';

export const textStream = (): Response =>
  sse([
    chunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }] } }], ...usage() }),
    chunk({
      candidates: [{ content: { role: 'model', parts: [{ text: 'there.' }] }, finishReason: 'STOP' }],
      ...usage(),
    }),
  ]);

export const EXPECTED_TOOL = { name: 'linear__create_issue', input: { title: 'Bug' } };

export const singleToolCall = (): Response =>
  sse([
    chunk({
      candidates: [{
        content: {
          role: 'model',
          // Arguments arrive structured, not as a JSON string.
          parts: [{ functionCall: { name: 'linear__create_issue', args: { title: 'Bug' } } }],
        },
        finishReason: 'STOP',
      }],
      ...usage(),
    }),
  ]);

export const parallelToolCalls = (): Response =>
  sse([
    chunk({
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { functionCall: { name: 'linear__create_issue', args: { a: 1 } } },
            { functionCall: { name: 'linear__search', args: { b: 2 } } },
          ],
        },
        finishReason: 'STOP',
      }],
      ...usage(),
    }),
  ]);

export const withReasoning = (): Response =>
  sse([
    chunk({
      candidates: [{
        content: { role: 'model', parts: [{ thought: true, text: 'Considering.' }] },
      }],
    }),
    chunk({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Hello there.' }] },
        finishReason: 'STOP',
      }],
      ...usage(),
    }),
  ]);

export const maxTokensStream = (): Response =>
  sse([
    chunk({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Truncated' }] },
        finishReason: 'MAX_TOKENS',
      }],
      ...usage(),
    }),
  ]);

const apiError = (status: number, statusText: string, message: string): (() => Response) =>
  () => json({ error: { code: status, message, status: statusText } }, status);

export const rateLimited = apiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded');
export const serverError = apiError(503, 'UNAVAILABLE', 'The model is overloaded');
export const badRequest = apiError(400, 'INVALID_ARGUMENT', 'Invalid value at contents');
export const authFailure = apiError(401, 'UNAUTHENTICATED', 'API key not valid');

/** Thought parts are summaries, not resumable state — nothing is replayed. */
export const SAMPLE_ARTIFACT = { thoughts: ['not resumable on this transport'] };
