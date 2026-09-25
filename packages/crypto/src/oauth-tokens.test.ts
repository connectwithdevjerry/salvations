import { describe, expect, it } from 'vitest';
import {
  hashOpaqueToken, mintOpaqueToken, opaqueTokenKind, pkceChallengeOf, verifyPkce,
} from './oauth-tokens';

describe('opaque tokens', () => {
  it('mints a prefixed token whose stored form is only its hash', () => {
    const minted = mintOpaqueToken('access');
    expect(minted.token.startsWith('hive_at_')).toBe(true);
    expect(minted.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.hash).toBe(hashOpaqueToken(minted.token));
    expect(minted.hash).not.toContain(minted.token.slice(8, 20));
  });

  it('names the kind from the prefix without trusting anything else', () => {
    expect(opaqueTokenKind(mintOpaqueToken('code').token)).toBe('code');
    expect(opaqueTokenKind(mintOpaqueToken('refresh').token)).toBe('refresh');
    expect(opaqueTokenKind('sk_live_abc_def')).toBeUndefined();
    expect(opaqueTokenKind('hive_at_')).toBeUndefined();
  });

  it('never mints the same token twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintOpaqueToken('code').token));
    expect(seen.size).toBe(200);
  });
});

describe('PKCE S256', () => {
  // The verifier from RFC 7636 appendix B, with its published challenge.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('derives the challenge the specification publishes', () => {
    expect(pkceChallengeOf(verifier)).toBe(challenge);
  });

  it('accepts the matching verifier and refuses everything else', () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(`${verifier}x`, challenge)).toBe(false);
    expect(verifyPkce(verifier, `${challenge.slice(0, -1)}A`)).toBe(false);
  });

  it('refuses a verifier outside the allowed shape before hashing it', () => {
    expect(verifyPkce('short', pkceChallengeOf('short'))).toBe(false);
    expect(verifyPkce('a'.repeat(129), pkceChallengeOf('a'.repeat(129)))).toBe(false);
    expect(verifyPkce(`${'a'.repeat(42)}!`, pkceChallengeOf(`${'a'.repeat(42)}!`))).toBe(false);
  });
});
