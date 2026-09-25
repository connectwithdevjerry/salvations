import { describe, expect, it } from 'vitest';
import { hashApiKey, mintApiKey, parseApiKey, verifyApiKey } from './api-key';
import { Secret } from './secret';

describe('api keys', () => {
  it('mints a parseable key and returns it exactly once, wrapped', () => {
    const minted = mintApiKey('live');
    expect(minted.key).toBeInstanceOf(Secret);
    const raw = minted.key.expose();
    expect(raw.startsWith('sk_live_')).toBe(true);
    expect(parseApiKey(raw)).toEqual({ environment: 'live', prefix: minted.prefix });
  });

  it('stores only a hash, never the key', () => {
    const minted = mintApiKey();
    expect(minted.keyHash).toHaveLength(64);
    expect(minted.keyHash).not.toContain(minted.key.expose());
    // The secret is taken positionally, not by splitting on '_': it is
    // base64url and may itself contain one, in which case the split gives an
    // empty string and the assertion passes or fails on the dice.
    const secret = minted.key.expose().slice(`sk_live_${minted.prefix}_`.length);
    expect(secret.length).toBeGreaterThan(20);
    expect(JSON.stringify(minted)).not.toContain(secret);
  });

  it('verifies a correct key and rejects a wrong one', () => {
    const minted = mintApiKey();
    expect(verifyApiKey(minted.key.expose(), minted.keyHash)).toBe(true);
    expect(verifyApiKey(`${minted.key.expose()}x`, minted.keyHash)).toBe(false);
    expect(verifyApiKey(mintApiKey().key.expose(), minted.keyHash)).toBe(false);
  });

  it('gives every key a distinct prefix and secret', () => {
    const keys = Array.from({ length: 200 }, () => mintApiKey());
    expect(new Set(keys.map((k) => k.prefix)).size).toBe(200);
    expect(new Set(keys.map((k) => k.keyHash)).size).toBe(200);
  });

  it('separates environments', () => {
    expect(parseApiKey(mintApiKey('test').key.expose())?.environment).toBe('test');
  });

  it('parses a secret containing base64url separators', () => {
    // The secret alphabet includes '_' and '-', so splitting on '_' produces a
    // variable number of parts and fails for a large fraction of real keys.
    expect(parseApiKey('sk_live_abc123_aa_bb-cc_dd'))
      .toEqual({ environment: 'live', prefix: 'abc123' });
  });

  it('parses every key it mints, across many samples', () => {
    // Guards the intermittent case: one lucky sample is not evidence.
    for (const environment of ['live', 'test'] as const) {
      for (let i = 0; i < 300; i++) {
        const minted = mintApiKey(environment);
        expect(parseApiKey(minted.key.expose()))
          .toEqual({ environment, prefix: minted.prefix });
      }
    }
  });

  it('rejects malformed keys without a database round trip', () => {
    for (const bad of ['', 'nonsense', 'sk_live_only3', 'pk_live_a_b', 'sk_prod_a_b', 'sk_live__b', 'sk_live_a_']) {
      expect(parseApiKey(bad)).toBeUndefined();
    }
  });

  it('hashes deterministically', () => {
    expect(hashApiKey('sk_live_a_b')).toBe(hashApiKey('sk_live_a_b'));
    expect(hashApiKey('sk_live_a_b')).not.toBe(hashApiKey('sk_live_a_c'));
  });
});
