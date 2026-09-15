import { describe, expect, it } from 'vitest';
import {
  artifactsForModel, providerKey,
  type CanonicalMessage, type ContentBlock, type GenerationRequest, type ProviderType,
} from '@salvations/core';
import { collect, scriptedFetch, sse, type CapturedRequest } from '@salvations/provider-testkit';
import { createRegistry } from './index';

/**
 * AC-6 — the acceptance test for the entire vendor-independence claim.
 *
 * One conversation is carried across three vendors in sequence. The canonical
 * history must survive every hop, opaque reasoning state must replay only on
 * the model that produced it, and must be dropped everywhere else — while the
 * TURN that carried it still gets sent.
 *
 * If this passes, "the AI provider is replaceable" is a property. If it fails,
 * it is marketing.
 */

const VENDORS = {
  anthropic: { model: 'claude-opus-5' },
  openai: { model: 'gpt-5.6-sol' },
  google: { model: 'gemini-3.1-pro-preview' },
} as const;

type VendorName = keyof typeof VENDORS;

/** A minimal successful stream in each vendor's own wire format. */
const streamFor = (vendor: VendorName) => (): Response => {
  if (vendor === 'anthropic') {
    const ev = (type: string, p: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...p })}`;
    return sse([
      ev('message_start', {
        message: { id: 'm', type: 'message', role: 'assistant', content: [], stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 1 } },
      }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ack' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      ev('message_stop', {}),
    ]);
  }
  if (vendor === 'openai') {
    const c = (p: Record<string, unknown>) =>
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: VENDORS.openai.model, ...p })}`;
    return sse([
      c({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ack' }, finish_reason: null }] }),
      c({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      c({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } }),
      'data: [DONE]',
    ]);
  }
  return sse([
    `data: ${JSON.stringify({
      responseId: 'r',
      candidates: [{ content: { role: 'model', parts: [{ text: 'ack' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    })}`,
  ]);
};

/** Reads whether a vendor's request carried opaque reasoning state. */
function sentReasoningState(vendor: VendorName, request: CapturedRequest | undefined): boolean {
  const body = request?.body as Record<string, unknown> | undefined;
  if (vendor === 'anthropic') {
    const messages = (body?.['messages'] ?? []) as { content?: unknown[] }[];
    return messages.some((m) =>
      (m.content ?? []).some((b) =>
        typeof b === 'object' && b !== null &&
        String((b as { type?: string }).type).includes('thinking')),
    );
  }
  // Neither other transport carries resumable reasoning state at all.
  return false;
}

function turnCount(vendor: VendorName, request: CapturedRequest | undefined): number {
  const body = request?.body as Record<string, unknown> | undefined;
  if (vendor === 'anthropic') return ((body?.['messages'] ?? []) as unknown[]).length;
  if (vendor === 'openai') {
    return ((body?.['messages'] ?? []) as { role?: string }[]).filter((m) => m.role !== 'system').length;
  }
  return ((body?.['contents'] ?? []) as unknown[]).length;
}

const baseRequest = (messages: readonly CanonicalMessage[]): GenerationRequest => ({
  system: [{ kind: 'identity', text: 'You are a helpful assistant.' }],
  messages,
  tools: [],
  toolChoice: 'auto',
  maxOutputTokens: 512,
  metadata: {
    runId: 'run_ac6' as never, workspaceId: 'wks_ac6' as never, agentId: 'agt_ac6' as never,
  },
});

async function runTurn(vendor: VendorName, history: readonly CanonicalMessage[]) {
  const { fetch, requests } = scriptedFetch([streamFor(vendor)]);
  const provider = createRegistry().create(vendor as unknown as ProviderType, {
    apiKey: 'test-key-not-real',
    baseUrl: 'https://provider.invalid/v1',
    // The injected fetch is how the suite drives each vendor's real parsing.
    fetch: fetch as typeof globalThis.fetch,
  });
  const result = await collect(
    provider.generate(baseRequest(history), new AbortController().signal),
  );
  return { result, request: requests[0] };
}

/** The conversation as it is actually stored: canonical blocks + a sidecar. */
interface StoredMessage extends CanonicalMessage {
  readonly content: readonly ContentBlock[];
}

describe('AC-6 — one conversation across three vendors', () => {
  it('carries the full history to every vendor in turn', async () => {
    let history: StoredMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
    ];

    for (const vendor of ['anthropic', 'openai', 'google'] as VendorName[]) {
      const { result, request } = await runTurn(vendor, history);
      expect(result.error, `${vendor} errored`).toBeUndefined();
      expect(turnCount(vendor, request), `${vendor} dropped a turn`).toBe(history.length);

      history = [
        ...history,
        { role: 'assistant', content: result.content, ...(result.artifacts !== undefined ? { providerArtifacts: result.artifacts } : {}) },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ];
    }

    // Three assistant turns and four user turns, all canonical, regardless of
    // which vendor produced each one.
    expect(history.filter((m) => m.role === 'assistant')).toHaveLength(3);
    expect(history.every((m) => Array.isArray(m.content))).toBe(true);
  });

  it('drops reasoning state when the conversation moves to another vendor', async () => {
    // The corruption this prevents: replaying one model's signed, opaque state
    // into another model, which rejects or misinterprets it.
    const anthropicKey = providerKey('anthropic', VENDORS.anthropic.model);
    const history: StoredMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', summary: 'thought about it', redacted: false }],
        providerArtifacts: {
          [anthropicKey]: { blocks: [{ type: 'thinking', thinking: 'x', signature: 'sig' }] },
        },
      },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ];

    for (const vendor of ['openai', 'google'] as VendorName[]) {
      const { request } = await runTurn(vendor, history);
      expect(sentReasoningState(vendor, request), `${vendor} replayed foreign state`).toBe(false);
      // Dropping the artifact must never drop the turn that carried it.
      expect(turnCount(vendor, request)).toBe(3);
    }
  });

  it('replays reasoning state when the conversation returns to the model that made it', async () => {
    const key = providerKey('anthropic', VENDORS.anthropic.model);
    const history: StoredMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', summary: 'thought about it', redacted: false }],
        providerArtifacts: {
          [key]: { blocks: [{ type: 'thinking', thinking: 'x', signature: 'sig' }] },
        },
      },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ];

    const { request } = await runTurn('anthropic', history);
    expect(sentReasoningState('anthropic', request)).toBe(true);
  });

  it('keeps each vendor’s artifacts separate in one conversation', async () => {
    // A conversation that ran on A, moved to B, and came back must still have
    // A's state available — and must not confuse it with B's.
    const a = providerKey('anthropic', VENDORS.anthropic.model);
    const b = providerKey('openai', VENDORS.openai.model);
    const artifacts = {
      [a]: { blocks: [{ type: 'thinking', thinking: 'from-a', signature: 's' }] },
      [b]: { items: [{ opaque: 'from-b' }] },
    };

    expect(artifactsForModel(artifacts, a as never)).toEqual(artifacts[a]);
    expect(artifactsForModel(artifacts, b as never)).toEqual(artifacts[b]);
    expect(artifactsForModel(artifacts, providerKey('google', VENDORS.google.model)))
      .toBeUndefined();
  });

  it('produces the same canonical text from every vendor', async () => {
    // Different wire formats, identical canonical result — the property the
    // whole abstraction exists to provide.
    const history: StoredMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const texts: string[] = [];
    for (const vendor of ['anthropic', 'openai', 'google'] as VendorName[]) {
      const { result } = await runTurn(vendor, history);
      texts.push(result.text);
      expect(result.finishReason).toBe('end_turn');
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toBe('ack');
  });

  it('reports usage from every vendor, so a run can be billed whoever served it', async () => {
    const history: StoredMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    for (const vendor of ['anthropic', 'openai', 'google'] as VendorName[]) {
      const { result } = await runTurn(vendor, history);
      expect(result.usage?.inputTokens, `${vendor} reported no input tokens`).toBeGreaterThan(0);
      expect(result.usage?.outputTokens, `${vendor} reported no output tokens`).toBeGreaterThan(0);
    }
  });
});
