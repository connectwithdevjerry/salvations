import { describe, expect, it } from 'vitest';
import { scriptedFetch } from '@salvations/provider-testkit';
import { createProvider } from './index';

/**
 * Embeddings come back in the order sent, whatever order the vendor answers
 * in. Memory and knowledge attach vector N to chunk N; a reordered response
 * that was trusted positionally would file one passage's meaning under
 * another.
 */
const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('OpenAI embeddings', () => {
  it('maps vectors by the index the vendor numbers them with', async () => {
    const { fetch, requests } = scriptedFetch([json({
      object: 'list',
      model: 'text-embedding-3-small',
      // Deliberately out of order.
      data: [
        { object: 'embedding', index: 1, embedding: [0, 1] },
        { object: 'embedding', index: 0, embedding: [1, 0] },
      ],
      usage: { prompt_tokens: 7, total_tokens: 7 },
    })]);

    const provider = createProvider({
      apiKey: 'test-key-not-real', baseUrl: 'https://provider.invalid/v1',
      fetch: fetch as typeof globalThis.fetch,
    });
    expect(provider.embed).toBeDefined();

    const result = await provider.embed!({ modelId: 'text-embedding-3-small', inputs: ['first', 'second'] });
    expect(result.vectors).toEqual([[1, 0], [0, 1]]);
    expect(result.dimensions).toBe(2);
    expect(result.usage.inputTokens).toBe(7);

    const body = requests[0]?.body as { model?: string; input?: string[] };
    expect(requests[0]?.url).toContain('/embeddings');
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toEqual(['first', 'second']);
  });
});
