import { describe, expect, it } from 'vitest';
import { json, scriptedFetch } from '@salvations/provider-testkit';
import { createProvider } from './index';

/**
 * A key is checked with the vendor before it is stored. The adapter has to
 * tell "the vendor said no" from "the vendor could not be reached", because
 * only the first is the person's key to fix.
 */
const provider = (fetch: ReturnType<typeof scriptedFetch>['fetch']) => createProvider({
  apiKey: 'test-key-not-real', baseUrl: 'https://provider.invalid/v1',
  fetch: fetch as typeof globalThis.fetch,
});

describe('Anthropic credential check', () => {
  it('accepts a key the vendor accepts, with one authenticated read', async () => {
    const { fetch, requests } = scriptedFetch([() => json({ data: [], has_more: false })]);
    expect(await provider(fetch).verify!()).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/models');
    expect(requests[0]?.method).toBe('GET');
  });

  it('reports a 401 as the key being rejected', async () => {
    const { fetch } = scriptedFetch([() => json(
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401,
    )]);
    const check = await provider(fetch).verify!();
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.kind).toBe('rejected');
      expect(check.message).toContain('401');
    }
  });

  it('reports a failed connection as unreachable, not as a bad key', async () => {
    const fetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof globalThis.fetch;
    const check = await createProvider({ apiKey: 'k', baseUrl: 'https://provider.invalid/v1', fetch }).verify!();
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.kind).toBe('unreachable');
  });
});
