import { describe, expect, it, vi } from 'vitest';
import type {
  AgentProvider, GenerationRequest, ProviderError, ProviderEvent, Usage,
} from '@salvations/core';
import { asProviderType, emptyUsage } from '@salvations/core';
import { ModelCallError, ModelCaller, backoffMs, type ModelAttempt } from './model-call';

const usage = (input: number, output: number): Usage => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0,
});

const REQUEST = { messages: [], tools: [] } as unknown as GenerationRequest;

/** A provider that replays one scripted stream per call. */
function scripted(...streams: ProviderEvent[][]): AgentProvider & { calls: number } {
  const queue = [...streams];
  const provider = {
    providerType: asProviderType('test'),
    calls: 0,
    describeModel: async () => ({}) as never,
    generate(): AsyncIterable<ProviderEvent> {
      provider.calls += 1;
      const events = queue.shift() ?? [];
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
  return provider;
}

const throwing = (error: unknown): AgentProvider => ({
  providerType: asProviderType('test'),
  describeModel: async () => ({}) as never,
  generate(): AsyncIterable<ProviderEvent> {
    return (async function* () {
      yield { type: 'start', messageId: 'm' } as ProviderEvent;
      throw error;
    })();
  },
});

const attempt = (provider: AgentProvider, label: 'primary' | 'fallback' = 'primary'): ModelAttempt =>
  ({ provider, request: REQUEST, modelId: 'model-x', label });

const finish = (text: string, over: Partial<Extract<ProviderEvent, { type: 'finish' }>> = {}) =>
  ({
    type: 'finish', reason: 'end_turn',
    content: [{ type: 'text', text }], usage: emptyUsage, ...over,
  }) as ProviderEvent;

const failure = (over: Partial<ProviderError> = {}): ProviderEvent => ({
  type: 'error',
  error: { kind: 'overloaded', message: 'busy', retryable: true, ...over },
});

const caller = (options: Record<string, unknown> = {}) =>
  new ModelCaller({ sleep: async () => undefined, random: () => 0.5, ...options });

const signal = new AbortController().signal;

describe('folding a stream', () => {
  it('returns the finish event’s content and usage', async () => {
    const provider = scripted([
      { type: 'start', messageId: 'm' },
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
      finish('hello', { usage: usage(10, 5) }),
    ]);

    const result = await caller().call([attempt(provider)], signal);
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.usage).toEqual(usage(10, 5));
    expect(result.finishReason).toBe('end_turn');
    expect(result.attempts).toBe(1);
  });

  it('accumulates usage reported before the finish event', async () => {
    // A stream that fails later still cost what it had spent by then.
    const provider = scripted([
      { type: 'usage', usage: usage(100, 0) },
      finish('done', { usage: usage(0, 20) }),
    ]);
    const result = await caller().call([attempt(provider)], signal);
    expect(result.usage).toEqual(usage(100, 20));
  });

  it('carries provider artifacts through untouched', async () => {
    const provider = scripted([finish('x', { providerArtifacts: { 'a:b': { opaque: 1 } } })]);
    const result = await caller().call([attempt(provider)], signal);
    expect(result.providerArtifacts).toEqual({ 'a:b': { opaque: 1 } });
  });

  it('treats a stream that ends without finishing as an error', async () => {
    // Reading a truncated stream as end_turn is how a platform produces
    // confidently incomplete answers.
    const provider = scripted([{ type: 'text_delta', text: 'half a th' }], [finish('recovered')]);
    // The first attempt streamed, so it is committed and must not be retried.
    await expect(caller().call([attempt(provider)], signal)).rejects.toThrow(/ended without/);
  });

  it('retries a truncated stream that had not yet streamed anything', async () => {
    const provider = scripted([{ type: 'usage', usage: usage(1, 0) }], [finish('recovered')]);
    const result = await caller().call([attempt(provider)], signal);
    expect(result.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(result.attempts).toBe(2);
  });

  it('preserves a non-end_turn finish reason', async () => {
    const provider = scripted([finish('', { reason: 'max_tokens' })]);
    expect((await caller().call([attempt(provider)], signal)).finishReason).toBe('max_tokens');
  });
});

describe('streaming to the event bus', () => {
  it('publishes text and tool starts as they arrive', async () => {
    const published: [string, unknown][] = [];
    const provider = scripted([
      { type: 'text_delta', text: 'a' },
      { type: 'reasoning_delta', text: 'thinking' },
      { type: 'tool_use_start', id: 't1', name: 'calendar__create' },
      finish('a'),
    ]);

    await new ModelCaller({
      publish: async (type, payload) => { published.push([type, payload]); },
    }).call([attempt(provider)], signal);

    expect(published.map(([type]) => type))
      .toEqual(['text_delta', 'reasoning_delta', 'tool_call_started']);
  });

  it('works with no bus attached', async () => {
    const provider = scripted([{ type: 'text_delta', text: 'a' }, finish('a')]);
    await expect(caller().call([attempt(provider)], signal)).resolves.toBeDefined();
  });
});

describe('retries', () => {
  it('retries a retryable failure and succeeds', async () => {
    const provider = scripted([failure()], [finish('second time')]);
    const result = await caller().call([attempt(provider)], signal);

    expect(result.content).toEqual([{ type: 'text', text: 'second time' }]);
    expect(result.attempts).toBe(2);
  });

  it('does not retry a failure the vendor marked permanent', async () => {
    const provider = scripted(
      [failure({ kind: 'invalid_request', retryable: false })], [finish('never reached')],
    );
    await expect(caller().call([attempt(provider)], signal)).rejects.toThrow(ModelCallError);
    expect(provider.calls).toBe(1);
  });

  it('does not retry once content has reached the user', async () => {
    // There is no honest way to unsay text on an append-only event log.
    const provider = scripted(
      [{ type: 'text_delta', text: 'partial' }, failure()], [finish('would duplicate')],
    );

    await expect(caller().call([attempt(provider)], signal)).rejects.toMatchObject({
      streamed: true,
    });
    expect(provider.calls).toBe(1);
  });

  it('does not treat a reasoning summary as committed content', async () => {
    // It is shown, but it is not the answer, so replaying it is harmless.
    const provider = scripted(
      [{ type: 'reasoning_delta', text: 'hmm' }, failure()], [finish('answer')],
    );
    expect((await caller().call([attempt(provider)], signal)).content)
      .toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('gives up after the attempt budget', async () => {
    const provider = scripted([failure()], [failure()], [failure()], [finish('too late')]);
    await expect(caller({ maxAttempts: 3 }).call([attempt(provider)], signal))
      .rejects.toMatchObject({ attempts: 3 });
  });

  it('honours a vendor-supplied retry delay over its own backoff', async () => {
    const sleep = vi.fn(async () => undefined);
    const provider = scripted([failure({ kind: 'rate_limit', retryAfterMs: 4_321 })], [finish('ok')]);

    await new ModelCaller({ sleep, random: () => 0.5 }).call([attempt(provider)], signal);
    expect(sleep).toHaveBeenCalledWith(4_321);
  });

  it('treats a thrown exception as non-retryable', async () => {
    // A throw is not a vendor signal; nothing in it says a tool-bearing request
    // is safe to repeat.
    const provider = throwing(new Error('socket hang up'));
    await expect(caller().call([attempt(provider)], signal))
      .rejects.toMatchObject({ providerError: { kind: 'transport', retryable: false } });
  });
});

describe('backoff', () => {
  it('spreads retries across the window rather than bunching them', () => {
    // Equal-spaced retries from many runs reproduce the overload they back off from.
    expect(backoffMs(0, { baseDelayMs: 1000, maxDelayMs: 20_000, random: () => 0 })).toBe(0);
    expect(backoffMs(0, { baseDelayMs: 1000, maxDelayMs: 20_000, random: () => 0.999 })).toBe(999);
  });

  it('grows the window exponentially and then caps it', () => {
    const at = (n: number) =>
      backoffMs(n, { baseDelayMs: 1000, maxDelayMs: 5_000, random: () => 1 });
    expect(at(0)).toBe(1000);
    expect(at(1)).toBe(2000);
    expect(at(2)).toBe(4000);
    expect(at(3)).toBe(5000);
  });
});

describe('fallback', () => {
  it('moves to the fallback model when the primary is exhausted', async () => {
    const primary = scripted([failure()], [failure()], [failure()]);
    const fallback = scripted([finish('from the other model')]);

    const result = await caller({ maxAttempts: 3 })
      .call([attempt(primary), attempt(fallback, 'fallback')], signal);

    expect(result.content).toEqual([{ type: 'text', text: 'from the other model' }]);
    expect(result.usedFallback).toBe(true);
    expect(result.attempts).toBe(4);
  });

  it('tries the fallback only once', async () => {
    // A second model also failing is a signal, not something to keep trying.
    const primary = scripted([failure({ retryable: false, kind: 'overloaded' })]);
    const fallback = scripted([failure()], [finish('never reached')]);

    await expect(
      caller().call([attempt(primary), attempt(fallback, 'fallback')], signal),
    ).rejects.toThrow(ModelCallError);
    expect(fallback.calls).toBe(1);
  });

  it('does not fall back from a failure the next model will repeat', async () => {
    // A content filter or a malformed request lands identically on any model,
    // and working through a list only wastes the user's time.
    const primary = scripted([failure({ kind: 'content_filter', retryable: false })]);
    const fallback = scripted([finish('never reached')]);

    await expect(
      caller().call([attempt(primary), attempt(fallback, 'fallback')], signal),
    ).rejects.toMatchObject({ providerError: { kind: 'content_filter' } });
    expect(fallback.calls).toBe(0);
  });

  it('falls back when the primary is overloaded', async () => {
    const primary = scripted([failure({ kind: 'overloaded' })]);
    const fallback = scripted([finish('ok')]);
    const result = await caller({ maxAttempts: 1 })
      .call([attempt(primary), attempt(fallback, 'fallback')], signal);
    expect(result.usedFallback).toBe(true);
  });

  it('refuses to run with nothing to call', async () => {
    await expect(caller().call([], signal)).rejects.toThrow(/at least one attempt/);
  });
});
