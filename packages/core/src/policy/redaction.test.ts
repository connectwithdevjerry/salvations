import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitiveKey, keyTokens, redactDeep } from './redaction';

describe('what counts as sensitive', () => {
  it('matches the spellings a schema author actually uses', () => {
    // A list of exact names is a list that is always one variant out of date.
    for (const key of [
      'password', 'passphrase', 'apiKey', 'api_key', 'x-api-key', 'clientSecret',
      'accessToken', 'authorization', 'Cookie', 'privateKey', 'session_id', 'pin', 'cvv',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('leaves ordinary arguments alone', () => {
    // Substring matching is wrong in both directions: `auth` would swallow
    // `authorName` and `pin` would swallow `shipping`. Redacting a useful
    // diagnostic field is a quiet loss nobody notices until they need it.
    for (const key of [
      'query', 'title', 'limit', 'startDate', 'attendees',
      'authorName', 'authority', 'shipping', 'keyword', 'sortKey', 'mapping', 'monkey',
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('reduces every spelling of one name to the same tokens', () => {
    // So the list does not have to enumerate apiKey, api_key and x-api-key.
    for (const key of ['apiKey', 'api_key', 'x-api-key', 'API_KEY', 'ApiKey']) {
      expect(keyTokens(key)).toContain('api');
      expect(isSensitiveKey(key)).toBe(true);
    }
  });
});

describe('redaction', () => {
  it('removes a secret while keeping the shape around it', () => {
    // Knowing a call passed { query, token: [redacted] } tells a reviewer far
    // more than a record saying only that arguments were present.
    expect(redactDeep({ query: 'invoices', apiKey: 'sk-live-1234' }))
      .toEqual({ query: 'invoices', apiKey: REDACTED });
  });

  it('redacts a non-string under a sensitive key', () => {
    // A PIN is still a secret when it is a number.
    expect(redactDeep({ pin: 4821 })).toEqual({ pin: REDACTED });
  });

  it('reaches into nested structures rather than blanking the branch', () => {
    // `auth` is not itself sensitive — it is a container — so the walk goes in
    // and redacts the field that is, keeping the shape a reviewer can read.
    expect(redactDeep({ auth: { headers: { authorization: 'Bearer abc' } }, page: 2 }))
      .toEqual({ auth: { headers: { authorization: REDACTED } }, page: 2 });
  });

  it('redacts inside an array of objects', () => {
    expect(redactDeep({ accounts: [{ name: 'a', secret: 's' }, { name: 'b', secret: 't' }] }))
      .toEqual({ accounts: [{ name: 'a', secret: REDACTED }, { name: 'b', secret: REDACTED }] });
  });

  it('truncates a very long value rather than storing it whole', () => {
    const result = redactDeep({ body: 'x'.repeat(5_000) }) as { body: string };
    expect(result.body.length).toBeLessThan(2_100);
    expect(result.body).toMatch(/truncated 3000/);
  });

  it('honours extra key names a tool schema declared', () => {
    expect(redactDeep({ seedPhrase: 'correct horse' }, { sensitiveKeys: ['seedPhrase'] }))
      .toEqual({ seedPhrase: REDACTED });
  });

  it('survives a cycle instead of throwing on the write path', () => {
    // A crash while persisting an audit record loses the record.
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    expect(redactDeep(cyclic)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('stops at a depth limit rather than walking forever', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redactDeep(deep))).toContain('depth limit');
  });

  it('caps a very long array', () => {
    const result = redactDeep(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(result).toHaveLength(100);
  });

  it('describes a value it cannot represent rather than dropping it', () => {
    expect(redactDeep({ fn: () => undefined })).toEqual({ fn: '[function]' });
  });
});
