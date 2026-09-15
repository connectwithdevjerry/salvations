/**
 * The shared conformance suite.
 *
 * A provider is not "supported" until it passes this. Adding a fourth adapter
 * must not require touching packages/runtime — this suite is what proves that
 * claim rather than asserting it.
 */
import { describe, expect, it } from 'vitest';
import { providerKey, type ProviderEvent } from '@salvations/core';
import { collect, collectSettled } from './collect';
import {
  baseRequest, expectCapabilityShape, scriptedFetch, type ConformanceTarget,
} from './contract';

export function runConformanceSuite(target: ConformanceTarget): void {
  const { providerType, modelId } = target;

  const drive = async (
    responses: readonly (() => Response)[],
    request = baseRequest(),
  ) => {
    const { fetch, requests } = scriptedFetch(responses);
    const provider = target.create(fetch);
    const result = await collectSettled(
      provider.generate(request, new AbortController().signal),
    );
    return { result, requests };
  };

  describe(`conformance: ${providerType}`, () => {
    describe('capabilities are honest', () => {
      it('describes the model with a self-consistent descriptor', async () => {
        const caps = await target.create(scriptedFetch([]).fetch).describeModel(modelId);
        expect(expectCapabilityShape(caps)).toEqual([]);
      });

      it('reports the model it was asked about', async () => {
        const caps = await target.create(scriptedFetch([]).fetch).describeModel(modelId);
        expect(caps.modelId).toBe(modelId);
      });

      it('declares streaming, which the runtime requires', async () => {
        const caps = await target.create(scriptedFetch([]).fetch).describeModel(modelId);
        expect(caps.streaming).toBe(true);
      });
    });

    describe('text streaming', () => {
      it('accumulates deltas into the expected text', async () => {
        const { result } = await drive([target.scenarios.text]);
        expect(result.error).toBeUndefined();
        expect(result.text).toBe(target.expectedText);
      });

      it('emits start before any delta and finish last', async () => {
        // Ordering is part of the contract: a consumer that renders deltas
        // before `start` has nowhere to put them.
        const { result } = await drive([target.scenarios.text]);
        const types = result.events.map((e: ProviderEvent) => e.type);
        expect(types[0]).toBe('start');
        expect(types.at(-1)).toBe('finish');
        const firstDelta = types.indexOf('text_delta');
        expect(firstDelta).toBeGreaterThan(0);
      });

      it('reports usage and a normalised finish reason', async () => {
        const { result } = await drive([target.scenarios.text]);
        expect(result.finishReason).toBe('end_turn');
        expect(result.usage?.inputTokens).toBeGreaterThan(0);
        expect(result.usage?.outputTokens).toBeGreaterThan(0);
      });

      it('produces canonical content matching the streamed text', async () => {
        const { result } = await drive([target.scenarios.text]);
        const text = result.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('');
        expect(text).toBe(target.expectedText);
      });

      it('always asks for a stream', async () => {
        // A non-streaming call is indistinguishable from a hang on a
        // short-lived function, and cannot be turned back into a stream.
        const { requests } = await drive([target.scenarios.text]);
        expect(target.inspect.isStreaming(requests[0]?.body)).toBe(true);
      });
    });

    describe('tool calls', () => {
      it('surfaces a single tool call as a canonical tool_use block', async () => {
        const { result } = await drive([target.scenarios.singleToolCall]);
        expect(result.finishReason).toBe('tool_use');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]?.name).toBe(target.expectedToolCall.name);
        expect(result.toolCalls[0]?.input).toEqual(target.expectedToolCall.input);
      });

      it('parses tool input as JSON rather than string-matching', async () => {
        const { result } = await drive([target.scenarios.singleToolCall]);
        expect(typeof result.toolCalls[0]?.input).toBe('object');
      });

      it('emits tool_use_start before tool_use_end for the same id', async () => {
        const { result } = await drive([target.scenarios.singleToolCall]);
        const start = result.events.findIndex((e) => e.type === 'tool_use_start');
        const end = result.events.findIndex((e) => e.type === 'tool_use_end');
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
      });

      it('preserves every call in a parallel turn, with distinct ids', async () => {
        // Losing one of a parallel set silently drops work the model asked for.
        const { result } = await drive([target.scenarios.parallelToolCalls]);
        expect(result.toolCalls.length).toBeGreaterThanOrEqual(2);
        const ids = new Set(result.toolCalls.map((c) => c.id));
        expect(ids.size).toBe(result.toolCalls.length);
      });

      it('includes every parallel call in the canonical content', async () => {
        const { result } = await drive([target.scenarios.parallelToolCalls]);
        const blocks = result.content.filter((b) => b.type === 'tool_use');
        expect(blocks).toHaveLength(result.toolCalls.length);
      });

      it('sends declared tools under provider-legal names', async () => {
        const caps = await target.create(scriptedFetch([]).fetch).describeModel(modelId);
        const pattern = new RegExp(caps.tools.namePattern);
        const request = baseRequest({
          tools: [
            {
              // Canonical names are alias__tool and can exceed a vendor's limit.
              name: 'a-very-long-binding-alias__a_tool_with_a_long_name_that_overflows',
              description: 'x',
              inputSchema: { type: 'object', properties: {} },
            },
            { name: 'short__tool', description: 'y', inputSchema: { type: 'object', properties: {} } },
          ],
        });
        const { requests } = await drive([target.scenarios.text], request);
        const names = target.inspect.toolNames(requests[0]?.body);
        expect(names).toHaveLength(2);
        for (const name of names) {
          expect(name.length).toBeLessThanOrEqual(caps.tools.maxNameLength);
          expect(pattern.test(name)).toBe(true);
        }
        // Truncation must never collide two distinct tools into one name.
        expect(new Set(names).size).toBe(2);
      });
    });

    describe('request encoding', () => {
      it('carries the system directives', async () => {
        const { requests } = await drive([target.scenarios.text]);
        expect(target.inspect.systemText(requests[0]?.body)).toContain('helpful assistant');
      });

      it('sends every conversation turn', async () => {
        const request = baseRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'one' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
            { role: 'user', content: [{ type: 'text', text: 'three' }] },
          ],
        });
        const { requests } = await drive([target.scenarios.text], request);
        expect(target.inspect.messageCount(requests[0]?.body)).toBe(3);
      });
    });

    describe('provider artifacts (AC-6)', () => {
      const own = providerKey(providerType, modelId);
      const foreign = providerKey('some-other-vendor', 'some-other-model');

      const withArtifacts = (key: string) =>
        baseRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'one' }] },
            {
              role: 'assistant',
              content: [{ type: 'reasoning', summary: 'considered options', redacted: false }],
              providerArtifacts: { [key]: target.sampleArtifact },
            },
            { role: 'user', content: [{ type: 'text', text: 'two' }] },
          ],
        });

      it('replays reasoning state produced by this same model', async () => {
        const { requests } = await drive([target.scenarios.text], withArtifacts(own));
        expect(target.inspect.replayedArtifact(requests[0]?.body, own)).toBe(true);
      });

      it('drops reasoning state produced by a different model', async () => {
        // Replaying a foreign model's opaque state corrupts the conversation;
        // dropping it is always safe. This is what makes AC-6 possible.
        const { requests } = await drive([target.scenarios.text], withArtifacts(foreign));
        expect(target.inspect.replayedArtifact(requests[0]?.body, foreign)).toBe(false);
      });

      it('still sends the turn when its artifact was dropped', async () => {
        // Dropping the artifact must not drop the message it was attached to.
        const { requests } = await drive([target.scenarios.text], withArtifacts(foreign));
        expect(target.inspect.messageCount(requests[0]?.body)).toBe(3);
      });

      it('keys any artifact it returns by its own provider and model', async () => {
        if (target.scenarios.withReasoning === undefined) return;
        const { result } = await drive([target.scenarios.withReasoning]);
        if (result.artifacts === undefined) return;
        expect(Object.keys(result.artifacts)).toEqual([own]);
      });
    });

    describe('finish reasons are normalised', () => {
      it('maps an output-ceiling stop to max_tokens', async () => {
        const { result } = await drive([target.scenarios.maxTokens]);
        expect(result.finishReason).toBe('max_tokens');
      });
    });

    describe('errors are normalised', () => {
      const cases = [
        { name: 'rate limit', scenario: 'rateLimited', kind: 'rate_limit', retryable: true },
        { name: 'server error', scenario: 'serverError', kind: 'overloaded', retryable: true },
        { name: 'bad request', scenario: 'badRequest', kind: 'invalid_request', retryable: false },
        { name: 'auth failure', scenario: 'authFailure', kind: 'authentication', retryable: false },
      ] as const;

      for (const testCase of cases) {
        it(`maps ${testCase.name} to ${testCase.kind} (retryable: ${testCase.retryable})`, async () => {
          const { result } = await drive([target.scenarios[testCase.scenario]]);
          const error = result.error;
          expect(error, 'expected an error event, not a throw').toBeDefined();
          expect(error?.kind).toBe(testCase.kind);
          expect(error?.retryable).toBe(testCase.retryable);
        });
      }

      it('reports failures as an error EVENT rather than throwing', async () => {
        // The runtime folds a stream; a throw mid-iteration loses whatever was
        // already emitted, including usage that has to be billed.
        const { result } = await drive([target.scenarios.rateLimited]);
        expect(result.threw).toBeUndefined();
      });

      it('preserves the raw vendor payload for unmapped signals', async () => {
        const { result } = await drive([target.scenarios.badRequest]);
        expect(result.error?.providerRaw).toBeDefined();
      });
    });

    describe('cancellation', () => {
      it('stops cleanly when the caller aborts', async () => {
        const { fetch } = scriptedFetch([target.scenarios.text]);
        const controller = new AbortController();
        controller.abort();
        const provider = target.create(fetch);
        const result = await collectSettled(
          provider.generate(baseRequest(), controller.signal),
        );
        // Either a clean error event or an empty stream; never a hang, and
        // never a partially-applied tool call.
        expect(result.toolCalls).toHaveLength(0);
      });
    });
  });
}

export { collect, collectSettled };
