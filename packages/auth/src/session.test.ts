import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS, clearCookie, createRefreshToken, hashRefreshToken,
  issueAccessToken, readCookie, refreshTokenMatches, sessionCookie, verifyAccessToken,
} from './session';

const SECRET = 's'.repeat(48);
const NOW = 1_700_000_000_000;
const now = () => NOW;

const issue = (over: Record<string, string> = {}) => issueAccessToken({
  secret: SECRET,
  issuer: 'https://app.test',
  userId: 'usr_1',
  sessionId: 'ses_1',
  email: 'someone@example.com',
  now,
  ...over,
});

const verify = (token: string, at = NOW) =>
  verifyAccessToken(token, SECRET, { issuer: 'https://app.test', now: () => at });

describe('access tokens', () => {
  it('carries the session it belongs to, so revoking that session ends it', () => {
    const claims = verify(issue());
    expect(claims.sub).toBe('usr_1');
    expect(claims.sid).toBe('ses_1');
    expect(claims.email).toBe('someone@example.com');
  });

  it('expires within fifteen minutes', () => {
    // The honest cost of stateless verification: revocation bites within this
    // window, not instantly.
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    const token = issue();
    expect(() => verify(token, NOW + 14 * 60_000)).not.toThrow();
    expect(() => verify(token, NOW + 20 * 60_000)).toThrow(/expired/);
  });

  it('rejects a token from another deployment', () => {
    const token = issueAccessToken({
      secret: SECRET, issuer: 'https://staging.test',
      userId: 'usr_1', sessionId: 'ses_1', email: 'e', now,
    });
    expect(() => verify(token)).toThrow(/not issued by an expected issuer/);
  });

  it('rejects a token that is ours by signature but missing our claims', () => {
    // Same secret, different minting path — a problem in its own right, and not
    // something to treat as a session.
    const foreign = issueAccessToken({
      secret: SECRET, issuer: 'https://app.test', userId: 'usr_1', sessionId: '', email: '', now,
    });
    const stripped = foreign.split('.').slice(0, 2).join('.');
    expect(() => verifyAccessToken(`${stripped}.bad`, SECRET, { issuer: 'https://app.test', now }))
      .toThrow();
  });
});

describe('refresh tokens', () => {
  it('stores only a hash, so a database dump yields nothing usable', () => {
    const refresh = createRefreshToken(NOW);
    expect(refresh.hash).not.toBe(refresh.token);
    expect(refresh.hash).toBe(hashRefreshToken(refresh.token));
    expect(refreshTokenMatches(refresh.token, refresh.hash)).toBe(true);
  });

  it('rejects a token that does not match the stored hash', () => {
    const refresh = createRefreshToken(NOW);
    expect(refreshTokenMatches('some-other-token', refresh.hash)).toBe(false);
  });

  it('compares in constant time and is length aware', () => {
    expect(refreshTokenMatches('x', '')).toBe(false);
  });

  it('mints a distinct token every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createRefreshToken().token));
    expect(seen.size).toBe(50);
  });

  it('expires thirty days out', () => {
    const refresh = createRefreshToken(NOW);
    expect(refresh.expiresAt.getTime() - NOW).toBe(30 * 24 * 60 * 60 * 1_000);
  });
});

describe('cookies', () => {
  it('is httpOnly and SameSite=Lax', () => {
    // httpOnly is the difference between an XSS bug that defaces a page and one
    // that steals every session. Lax still allows the redirect back from Google.
    const cookie = sessionCookie('salv_at', 'value', { maxAgeSeconds: 900, secure: true });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=900');
  });

  it('omits Secure only when told to, for plain-HTTP localhost', () => {
    // Setting it there silently drops the cookie and sign-in appears broken.
    expect(sessionCookie('a', 'b', { maxAgeSeconds: 1, secure: false })).not.toContain('Secure');
  });

  it('clears with Max-Age=0 rather than a past date', () => {
    expect(clearCookie('salv_at', true)).toContain('Max-Age=0');
  });

  it('reads a cookie out of a header', () => {
    const header = 'other=1; salv_at=the-token; salv_rt=another';
    expect(readCookie(header, 'salv_at')).toBe('the-token');
    expect(readCookie(header, 'salv_rt')).toBe('another');
    expect(readCookie(header, 'missing')).toBeUndefined();
    expect(readCookie(null, 'salv_at')).toBeUndefined();
  });

  it('is not fooled by a name that is a suffix of another', () => {
    // `salv_at` must not match `x_salv_at`.
    expect(readCookie('x_salv_at=wrong; salv_at=right', 'salv_at')).toBe('right');
  });
});
