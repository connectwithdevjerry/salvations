/**
 * Wire fixtures for this vendor's chunk format.
 */
import { json, sse } from '@salvations/provider-testkit';

const chunk = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-conformance', object: 'chat.completion.chunk',
    created: 1789000000, model: 'gpt-5.6-sol', ...payload,
  })}`;

const DONE = 'data: [DONE]';

const usageChunk = (): string =>
  chunk({
    choices: [],
    usage: {
      prompt_tokens: 12, completion_tokens: 7, total_tokens: 19,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  });

export const EXPECTED_TEXT = 'Hello there.';

export const textStream = (): Response =>
  sse([
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { content: 'there.' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    usageChunk(),
    DONE,
  ]);

export const EXPECTED_TOOL = { name: 'linear__create_issue', input: { title: 'Bug' } };

export const singleToolCall = (): Response =>
  sse([
    chunk({
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0, id: 'call_1', type: 'function',
            function: { name: 'linear__create_issue', arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    }),
    // Arguments arrive split, so the decoder must accumulate.
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"title":' } }] }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Bug"}' } }] }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    usageChunk(),
    DONE,
  ]);

export const parallelToolCalls = (): Response =>
  sse([
    chunk({
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'linear__create_issue', arguments: '{"a":1}' } },
            { index: 1, id: 'call_2', type: 'function', function: { name: 'linear__search', arguments: '{"b":2}' } },
          ],
        },
        finish_reason: null,
      }],
    }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    usageChunk(),
    DONE,
  ]);

export const maxTokensStream = (): Response =>
  sse([
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Truncated' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
    usageChunk(),
    DONE,
  ]);

const apiError = (status: number, type: string, message: string): (() => Response) =>
  () => json({ error: { message, type, code: null } }, status);

export const rateLimited = apiError(429, 'rate_limit_error', 'Rate limit reached');
export const serverError = apiError(503, 'server_error', 'The server is overloaded');
export const badRequest = apiError(400, 'invalid_request_error', 'Invalid value for messages');
export const authFailure = apiError(401, 'invalid_api_key', 'Incorrect API key provided');

/** This transport surfaces no reasoning state, so there is nothing to replay. */
export const SAMPLE_ARTIFACT = { items: [{ type: 'reasoning', opaque: 'not-carried-here' }] };
