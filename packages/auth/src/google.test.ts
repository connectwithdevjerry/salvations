import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import {
  GOOGLE_ISSUERS, GoogleAuthError, GoogleKeys, authorizationUrl, beginSignIn, completeSignIn,
  signInExpired, statesMatch, type GoogleConfig,
} from './google';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

const NOW = 1_700_000_000_000;
const CONFIG: GoogleConfig = {
  clientId: 'client.apps.googleusercontent.com',
  clientSecret: 'secret',
  redirectUri: 'https://app.test/api/auth/google/callback',
  now: () => NOW,
};

const METADATA = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
};

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function idToken(claims: Record<string, unknown>, kid = 'k1'): string {
  const input = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(claims)}`;
  const signer = createSign('RSA-SHA256').update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString('base64url')}`;
}

const claimsFor = (nonce: string, over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CONFIG.clientId,
  sub: '110000000000000000001',
  email: 'someone@example.com',
  email_verified: true,
  name: 'Someone',
  nonce,
  iat: Math.floor(NOW / 1_000),
  exp: Math.floor(NOW / 1_000) + 600,
  ...over,
});

interface Script { metadata?: unknown; jwks?: unknown; token?: unknown; tokenStatus?: number }

function fakeGoogle(script: Script = {}) {
  const calls: { url: string; body?: URLSearchParams }[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      ...(typeof init?.body === 'string' ? { body: new URLSearchParams(init.body) } : {}),
    });

    if (url.includes('openid-configuration')) return json(script.metadata ?? METADATA);
    if (url.includes('certs')) return json(script.jwks ?? { keys: [JWK] });
    if (url.includes('token')) {
      return json(script.token ?? {}, script.tokenStatus ?? 200);
    }
    return json({}, 404);
  }) as typeof globalThis.fetch;

  return { fetchFn, calls };
}

describe('starting a sign-in', () => {
  it('mints distinct state, nonce and PKCE verifier', () => {
    const a = beginSignIn();
    const b = beginSignIn();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(a.state);
    expect(a.codeVerifier).not.toBe(a.nonce);
    expect(a.state.length).toBeGreaterThanOrEqual(43);
  });

  it('sends a PKCE challenge, never the verifier', () => {
    // The verifier is what proves the code is being redeemed by the browser
    // that started the flow; sending it up front would defeat the point.
    const pending = beginSignIn();
    const url = new URL(authorizationUrl(CONFIG, METADATA, pending));

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).not.toBe(pending.codeVerifier);
    expect(url.toString()).not.toContain(pending.codeVerifier);
  });

  it('asks only for identity, not for offline access', () => {
    // A refresh token would be a long-lived credential with nothing to spend it
    // on: we establish who someone is, we do not act at Google on their behalf.
    const url = new URL(authorizationUrl(CONFIG, METADATA, beginSignIn()));
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('access_type')).toBeNull();
  });

  it('carries state and nonce to Google', () => {
    const pending = beginSignIn();
    const url = new URL(authorizationUrl(CONFIG, METADATA, pending));
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(url.searchParams.get('nonce')).toBe(pending.nonce);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });

  it('expires an unfinished sign-in', () => {
    const pending = { ...beginSignIn(), createdAt: NOW };
    expect(signInExpired(pending, NOW + 60_000)).toBe(false);
    expect(signInExpired(pending, NOW + 11 * 60_000)).toBe(true);
  });
});

describe('completing a sign-in', () => {
  const pending = { ...beginSignIn(), createdAt: NOW };

  it('exchanges the code and returns a verified identity', async () => {
    const google = fakeGoogle({ token: { id_token: idToken(claimsFor(pending.nonce)) } });
    const keys = new GoogleKeys({ fetch: google.fetchFn, now: () => NOW });

    const identity = await completeSignIn(
      { ...CONFIG, fetch: google.fetchFn }, keys, pending,
      { code: 'the-code', state: pending.state },
    );

    expect(identity).toMatchObject({
      subject: '110000000000000000001',
      email: 'someone@example.com',
      emailVerified: true,
      name: 'Someone',
    });
  });

  it('sends the PKCE verifier and the secret over the back channel', async () => {
    const google = fakeGoogle({ token: { id_token: idToken(claimsFor(pending.nonce)) } });
    const keys = new GoogleKeys({ fetch: google.fetchFn, now: () => NOW });

    await completeSignIn(
      { ...CONFIG, fetch: google.fetchFn }, keys, pending,
      { code: 'the-code', state: pending.state },
    );

    const exchange = google.calls.find((c) => c.url.includes('token'));
    expect(exchange?.body?.get('code_verifier')).toBe(pending.codeVerifier);
    expect(exchange?.body?.get('client_secret')).toBe('secret');
    expect(exchange?.body?.get('grant_type')).toBe('authorization_code');
  });

  it('refuses a callback whose state does not match', async () => {
    // CSRF: without this, an attacker can complete a sign-in into your session.
    const google = fakeGoogle({ token: { id_token: idToken(claimsFor(pending.nonce)) } });
    const keys = new GoogleKeys({ fetch: google.fetchFn, now: () => NOW });

    await expect(completeSignIn(
      { ...CONFIG, fetch: google.fetchFn }, keys, pending,
      { code: 'the-code', state: 'not-the-state' },
    )).rejects.toThrow(/does not match the request/);

    expect(google.calls.some((c) => c.url.includes('token'))).toBe(false);
  });

  it('refuses an identity token replayed from another sign-in', async () => {
    const google = fakeGoogle({ token: { id_token: idToken(claimsFor('a-different-nonce')) } });
    const keys = new GoogleKeys({ fetch: google.fetchFn, now: () => NOW });

    await expect(completeSignIn(
      { ...CONFIG, fetch: google.fetchFn }, keys, pending,
      { code: 'the-code', state: pending.state },
    )).rejects.toThrow(GoogleAuthError);
  });

  it('refuses a token signed by a key Google does not publish', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const foreign = { ...other.publicKey.export({ format: 'jwk' }), kid: 'k1' };
    const google = fakeGoogle({
      token: { id_token: idToken(claimsFor(pending.nonce)) },
      jwks: { keys: [foreign] },
    });
    const keys = new GoogleKeys({ fetch: google.fetchFn, now: () => NOW });

    await expect(completeSignIn(
      { ...CONFIG, fetch: google.fetchFn }, keys, pending,
      { code: 'the-code', state: pending.state },
    )).rejects.toThrow(/could not be verified/);
  });

  it('does not leak Google’s error body when an exchange fails', async () => {
    // Google's body can name the client id; the status is enough for a log.
    const google = fakeGoogle({ tokenStatus: 400, token: { error: 'invalid_client', client_id: 'leak' } });
    const keys = new GoogleKeys({ fetch: google.fetchFn, now: () => NOW });

    await expect(completeSignIn(
      { ...CONFIG, fetch: google.fetchFn }, keys, pending,
      { code: 'the-code', state: pending.state },
    )).rejects.toThrow(/HTTP 400/);
  });
});

describe('key handling', () => {
  it('caches discovery and keys rather than fetching per sign-in', async () => {
    const google = fakeGoogle();
    const keys = new GoogleKeys({ fetch: google.fetchFn, now: () => NOW });

    await keys.keyFor('k1');
    await keys.keyFor('k1');

    expect(google.calls.filter((c) => c.url.includes('certs'))).toHaveLength(1);
  });

  it('refetches once for a key it has not seen, which is what rotation looks like', async () => {
    const rotated = { ...JWK, kid: 'k2' };
    let served = [JWK];
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      const body = url.includes('certs') ? { keys: served } : METADATA;
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;

    const keys = new GoogleKeys({ fetch: fetchFn, now: () => NOW });
    await keys.keyFor('k1');
    served = [JWK, rotated];

    // Would fail if the cache were treated as authoritative.
    expect((await keys.keyFor('k2')).kid).toBe('k2');
  });

  it('refuses a discovery document claiming another issuer', async () => {
    // It says who it speaks for; one claiming a different issuer may not be
    // used to verify Google's tokens.
    const google = fakeGoogle({ metadata: { ...METADATA, issuer: 'https://evil.test' } });
    const keys = new GoogleKeys({ fetch: google.fetchFn, now: () => NOW });
    await expect(keys.metadata()).rejects.toThrow(/unexpected issuer/);
  });

  it('will not guess between several unlabelled keys', async () => {
    // Trying keys until one verifies is a downgrade, not a fallback.
    const google = fakeGoogle({ jwks: { keys: [JWK, { ...JWK, kid: 'k2' }] } });
    const keys = new GoogleKeys({ fetch: google.fetchFn, now: () => NOW });
    await expect(keys.keyFor(undefined)).rejects.toThrow(/did not publish the key/);
  });
});

describe('state comparison', () => {
  it('is constant time and length aware', () => {
    expect(statesMatch('abc', 'abc')).toBe(true);
    expect(statesMatch('abc', 'abd')).toBe(false);
    expect(statesMatch('abc', 'abcd')).toBe(false);
    expect(statesMatch('', '')).toBe(true);
  });
});

describe('issuer handling', () => {
  it('accepts both spellings Google has used', () => {
    expect(GOOGLE_ISSUERS).toContain('https://accounts.google.com');
    expect(GOOGLE_ISSUERS).toContain('accounts.google.com');
  });
});
