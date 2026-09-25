import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { JwtError, signHs256, unverifiedKeyId, verifyHs256, verifyRs256, type Jwk } from './jwt';

const SECRET = 'a'.repeat(48);
const NOW = 1_700_000_000_000;
const now = () => NOW;

const base = {
  issuer: 'https://app.test',
  audience: 'salvations',
  subject: 'usr_1',
  expiresInSeconds: 900,
  now,
};

const verifyOptions = { issuer: 'https://app.test', audience: 'salvations', now };

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('tokens we issue', () => {
  it('round-trips a token with its claims', () => {
    const token = signHs256(SECRET, { ...base, claims: { sid: 'ses_1', role: 'owner' } });
    const claims = verifyHs256(token, SECRET, verifyOptions);

    expect(claims.sub).toBe('usr_1');
    expect(claims['sid']).toBe('ses_1');
    expect(claims.exp).toBe(Math.floor(NOW / 1_000) + 900);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signHs256(SECRET, base);
    expect(() => verifyHs256(token, 'b'.repeat(48), verifyOptions))
      .toThrow(/invalid signature/);
  });

  it('rejects a tampered payload', () => {
    // The signature covers header and payload together, so editing either
    // invalidates it — which is the entire point.
    const token = signHs256(SECRET, base);
    const [header, , signature] = token.split('.') as [string, string, string];
    const forged = `${header}.${b64({ sub: 'usr_admin', exp: 9e9, iss: 'https://app.test', aud: 'salvations' })}.${signature}`;

    expect(() => verifyHs256(forged, SECRET, verifyOptions)).toThrow(/invalid signature/);
  });
});

describe('the attacks that matter', () => {
  it('refuses alg: none', () => {
    // The classic: strip the signature, claim the token needs none.
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'usr_1', exp: 9e9, iss: 'https://app.test', aud: 'salvations' })}.`;
    expect(() => verifyHs256(token, SECRET, verifyOptions))
      .toThrow(/not signed the way this application signs/);
  });

  it('refuses an algorithm the token chose for itself', () => {
    // Algorithm confusion: the verifier must take the algorithm from US, never
    // from the header, or an RSA public key becomes an HMAC secret.
    const token = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'usr_1', exp: 9e9, iss: 'https://app.test', aud: 'salvations' })}.AAAA`;
    expect(() => verifyHs256(token, SECRET, verifyOptions)).toThrow(JwtError);
  });

  it('refuses a token minted for a different audience', () => {
    // A valid token — just not for us. Accepting it lets another relying
    // party's token in.
    const token = signHs256(SECRET, { ...base, audience: 'someone-else' });
    expect(() => verifyHs256(token, SECRET, verifyOptions))
      .toThrow(/not issued for this application/);
  });

  it('refuses a token from a different issuer', () => {
    const token = signHs256(SECRET, { ...base, issuer: 'https://evil.test' });
    expect(() => verifyHs256(token, SECRET, verifyOptions))
      .toThrow(/not issued by an expected issuer/);
  });

  it('refuses an expired token', () => {
    // Well past the 60s clock tolerance: at exactly exp + tolerance the token
    // is still good, which is the boundary the drift test below pins down.
    const token = signHs256(SECRET, { ...base, expiresInSeconds: 60 });
    expect(() => verifyHs256(token, SECRET, { ...verifyOptions, now: () => NOW + 200_000 }))
      .toThrow(/expired/);
  });

  it('refuses a token with no expiry at all', () => {
    // A token that never expires is a permanent credential, and revocation
    // cannot reach it.
    const signed = signHs256(SECRET, base);
    const [header] = signed.split('.') as [string];
    const noExp = `${header}.${b64({ sub: 'usr_1', iss: 'https://app.test', aud: 'salvations' })}.x`;
    expect(() => verifyHs256(noExp, SECRET, verifyOptions)).toThrow(JwtError);
  });

  it('refuses a malformed token rather than guessing', () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-token']) {
      expect(() => verifyHs256(bad, SECRET, verifyOptions)).toThrow(JwtError);
    }
  });

  it('allows only a small amount of clock drift', () => {
    // A generous skew extends the life of every token, including a revoked one.
    const token = signHs256(SECRET, { ...base, expiresInSeconds: 0 });
    expect(() => verifyHs256(token, SECRET, { ...verifyOptions, now: () => NOW + 30_000 }))
      .not.toThrow();
    expect(() => verifyHs256(token, SECRET, { ...verifyOptions, now: () => NOW + 90_000 }))
      .toThrow(/expired/);
  });
});

describe('external identity tokens', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' } as Jwk;

  const issue = (claims: Record<string, unknown>, kid = 'k1'): string => {
    const input = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(claims)}`;
    const signer = createSign('RSA-SHA256').update(input);
    signer.end();
    return `${input}.${signer.sign(privateKey).toString('base64url')}`;
  };

  const googleOptions = {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: 'client-id.apps.googleusercontent.com',
    now,
  };

  const validClaims = {
    iss: 'https://accounts.google.com',
    aud: 'client-id.apps.googleusercontent.com',
    sub: '1234567890',
    email: 'someone@example.com',
    email_verified: true,
    nonce: 'n-1',
    exp: Math.floor(NOW / 1_000) + 600,
    iat: Math.floor(NOW / 1_000),
  };

  it('accepts a correctly signed identity token', () => {
    const claims = verifyRs256(issue(validClaims), jwk, { ...googleOptions, nonce: 'n-1' });
    expect(claims.sub).toBe('1234567890');
    expect(claims['email']).toBe('someone@example.com');
  });

  it('accepts either spelling of the Google issuer', () => {
    // Google has issued both, and hard-coding one of them breaks sign-in for
    // the tokens carrying the other.
    const claims = verifyRs256(
      issue({ ...validClaims, iss: 'accounts.google.com' }), jwk, googleOptions,
    );
    expect(claims.iss).toBe('accounts.google.com');
  });

  it('rejects a token signed by a different key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const foreignJwk = { ...other.publicKey.export({ format: 'jwk' }), kid: 'k1' } as Jwk;
    expect(() => verifyRs256(issue(validClaims), foreignJwk, googleOptions))
      .toThrow(/invalid signature/);
  });

  it('rejects a replayed token from another sign-in', () => {
    // The nonce binds the token to THIS attempt.
    expect(() => verifyRs256(issue(validClaims), jwk, { ...googleOptions, nonce: 'n-2' }))
      .toThrow(/does not match the sign-in/);
  });

  it('rejects a token for another OAuth client', () => {
    expect(() => verifyRs256(
      issue({ ...validClaims, aud: 'someone-elses-client' }), jwk, googleOptions,
    )).toThrow(/not issued for this application/);
  });

  it('reads the key id without trusting anything else in the token', () => {
    // Safe because the kid only SELECTS a key; a forged one picks a key whose
    // signature then fails.
    expect(unverifiedKeyId(issue(validClaims, 'k9'))).toBe('k9');
  });
});
