/**
 * Wire fixtures for this vendor's streaming format.
 *
 * Canned bytes rather than mocks, so the conformance suite drives the REAL SDK
 * parser. A hand-rolled mock of the SDK would prove the mock works.
 */
import { json, sse } from '@salvations/provider-testkit';

const event = (type: string, payload: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}`;

const messageStart = (inputTokens = 12): string =>
  event('message_start', {
    message: {
      id: 'msg_conformance', type: 'message', role: 'assistant',
      model: 'claude-opus-5', content: [], stop_reason: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });

const messageDelta = (stopReason: string, outputTokens = 7): string =>
  event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });

const messageStop = (): string => event('message_stop', {});

export const EXPECTED_TEXT = 'Hello there.';

export const textStream = (): Response =>
  sse([
    messageStart(),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello ' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'there.' } }),
    event('content_block_stop', { index: 0 }),
    messageDelta('end_turn'),
    messageStop(),
  ]);

export const EXPECTED_TOOL = { name: 'linear__create_issue', input: { title: 'Bug' } };

export const singleToolCall = (): Response =>
  sse([
    messageStart(),
    event('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'linear__create_issue', input: {} },
    }),
    // Split across deltas on purpose: the decoder must accumulate rather than
    // assume one chunk carries the whole argument object.
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"title":' } }),
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"Bug"}' } }),
    event('content_block_stop', { index: 0 }),
    messageDelta('tool_use'),
    messageStop(),
  ]);

export const parallelToolCalls = (): Response =>
  sse([
    messageStart(),
    event('content_block_start', {
      index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'linear__create_issue', input: {} },
    }),
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }),
    event('content_block_stop', { index: 0 }),
    event('content_block_start', {
      index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'linear__search', input: {} },
    }),
    event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"b":2}' } }),
    event('content_block_stop', { index: 1 }),
    messageDelta('tool_use'),
    messageStop(),
  ]);

export const withReasoning = (): Response =>
  sse([
    messageStart(),
    event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Considering.' } }),
    event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
    event('content_block_stop', { index: 0 }),
    event('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hello there.' } }),
    event('content_block_stop', { index: 1 }),
    messageDelta('end_turn'),
    messageStop(),
  ]);

export const maxTokensStream = (): Response =>
  sse([
    messageStart(),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Truncated' } }),
    event('content_block_stop', { index: 0 }),
    messageDelta('max_tokens'),
    messageStop(),
  ]);

const apiError = (status: number, type: string, message: string): (() => Response) =>
  () => json({ type: 'error', error: { type, message } }, status);

export const rateLimited = apiError(429, 'rate_limit_error', 'Rate limit exceeded');
export const serverError = apiError(529, 'overloaded_error', 'Overloaded');
export const badRequest = apiError(400, 'invalid_request_error', 'messages: invalid');
export const authFailure = apiError(401, 'authentication_error', 'invalid x-api-key');

/**
 * A representative opaque reasoning payload, in the shape this adapter stores.
 *
 * The signature is what makes replay verbatim-or-nothing: a rebuilt or edited
 * block is rejected as tampered, which is why a summary can never substitute.
 */
export const SAMPLE_ARTIFACT = {
  blocks: [{ type: 'thinking', thinking: 'Considering options.', signature: 'sig-opaque' }],
};
