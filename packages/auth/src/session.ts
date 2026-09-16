/**
 * Sessions: a short JWT, and a revocable refresh token.
 *
 * A pure JWT session cannot be revoked. Whatever is written in it stays true
 * until it expires, so a signed-out user, a removed workspace member and a
 * compromised account all keep working — which is unacceptable on a platform
 * where an agent acts with delegated authority.
 *
 * A pure database session gives up the one thing JWTs are good for: verifying a
 * caller without a round trip, which the Phase 4 worker will need.
 *
 * So: both halves, each doing what it is good at.
 *
 *   ACCESS TOKEN   a 15-minute JWT, verified with no database read.
 *   REFRESH TOKEN  opaque, stored as a HASH, checked and rotated on every use.
 *
 * Revoking deletes the session row. The refresh dies instantly; the access
 * token dies within fifteen minutes. That window is the honest cost of stateless
 * verification, and it is written down here rather than discovered later.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { signHs256, verifyHs256, type JwtClaims, type VerifyOptions } from './jwt';

/** Short enough that revocation bites quickly; long enough to avoid churn. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** How long a session may be refreshed before signing in again. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** Renewed on use, so an active session stays alive and an idle one lapses. */
export const REFRESH_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export const AUDIENCE = 'salvations';

export interface SessionClaims extends JwtClaims {
  /** The session row this token belongs to. Revoking that row ends it. */
  readonly sid: string;
  readonly email: string;
}

export interface IssueOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly now?: () => number;
}

export const issueAccessToken = (options: IssueOptions): string =>
  signHs256(options.secret, {
    issuer: options.issuer,
    audience: AUDIENCE,
    subject: options.userId,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    claims: { sid: options.sessionId, email: options.email },
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

export function verifyAccessToken(
  token: string,
  secret: string,
  options: Omit<VerifyOptions, 'audience'>,
): SessionClaims {
  const claims = verifyHs256(token, secret, { ...options, audience: AUDIENCE });
  if (typeof claims['sid'] !== 'string' || typeof claims['email'] !== 'string') {
    // Ours always carry both. One that does not was minted by something else
    // with the same secret, which is a problem in its own right.
    throw new Error('This session token is missing required claims.');
  }
  return claims as SessionClaims;
}

export interface NewRefreshToken {
  /** Given to the browser. Never stored. */
  readonly token: string;
  /** Stored. A database dump does not yield usable tokens. */
  readonly hash: string;
  readonly expiresAt: Date;
}

/**
 * Mints a refresh token.
 *
 * Hashed with SHA-256 rather than scrypt: unlike a password this is 256 bits of
 * machine-generated randomness, so there is nothing to brute force and the cost
 * of a slow KDF would be paid on every refresh for no gain.
 */
export function createRefreshToken(now = Date.now()): NewRefreshToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashRefreshToken(token),
    expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
  };
}

export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('base64url');

export function refreshTokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashRefreshToken(token));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The cookie the browser holds.
 *
 * `httpOnly` so script cannot read it — the difference between an XSS bug that
 * defaces a page and one that steals every session. `sameSite: lax` so a
 * cross-site form post cannot act as the user while top-level navigation back
 * from Google still works. `secure` everywhere except plain-HTTP localhost,
 * where setting it would silently drop the cookie during development.
 */
export function sessionCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean; path?: string },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${options.maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Expires a cookie.
 *
 * `Max-Age=0` rather than a past date: unambiguous everywhere.
 *
 * The PATH matters and is why this takes one. A cookie is identified by name
 * AND path, so clearing a cookie set at `/api/auth/refresh` with a directive
 * scoped to `/` does not remove it. Appending a second `Path` to the string
 * instead is worse than useless — browsers disagree about which of two wins,
 * so the same code either clears the cookie or silently leaves it behind
 * depending on who is looking.
 */
export const clearCookie = (name: string, secure: boolean, path = '/'): string =>
  sessionCookie(name, '', { maxAgeSeconds: 0, secure, path });

export const ACCESS_COOKIE = 'salv_at';
export const REFRESH_COOKIE = 'salv_rt';
export const PENDING_COOKIE = 'salv_oauth';

/** Parses a Cookie header. Returns the FIRST value for a name. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}
