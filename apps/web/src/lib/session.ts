/**
 * Establishing who is calling.
 *
 * One function decides it for every request, so there is no "current user"
 * global and no handler that forgot to check. A caller is a verified session, a
 * verified API key, or nobody.
 */
import {
  ACCESS_COOKIE, REFRESH_COOKIE, clearCookie, readCookie, sessionCookie,
  verifyAccessToken, type SessionClaims,
} from '@salvations/auth';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_IDLE_TTL_MS, createRefreshToken } from '@salvations/auth';
import { issueAccessToken } from '@salvations/auth';
import { UserRepository, type AuthSessionDoc, type UserDoc } from '@salvations/db';
import { db } from './db';
import { env } from './env';

/** The issuer claim, and the origin everything else is built from. */
export const issuer = (): string => env().PUBLIC_BASE_URL.replace(/\/$/, '');

/**
 * Whether cookies get the Secure attribute.
 *
 * Derived from the configured origin rather than from NODE_ENV: a production
 * build served over plain HTTP for a demo would otherwise set Secure and drop
 * every cookie, and sign-in would appear broken for no visible reason.
 */
export const secureCookies = (): boolean => issuer().startsWith('https://');

/**
 * The refresh cookie's path.
 *
 * Named once because it has to match in three places — set, clear, and the
 * route that reads it — and a mismatch between any two of them is invisible
 * until someone cannot sign out.
 */
export const REFRESH_COOKIE_PATH = '/api/auth/refresh';

export interface Caller {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
}

/**
 * Reads the access token.
 *
 * Verification is local — a signature check and some claim comparisons, no
 * database read. That is what the JWT half of the session design buys, and it
 * is why the token is short-lived: this path cannot see a revocation.
 */
export function readCaller(request: Request): Caller | undefined {
  const token = readCookie(request.headers.get('cookie'), ACCESS_COOKIE);
  if (token === undefined) return undefined;

  let claims: SessionClaims;
  try {
    claims = verifyAccessToken(token, env().AUTH_JWT_SECRET, { issuer: issuer() });
  } catch {
    // Expired, tampered with, or minted by another deployment. All the same
    // answer: not signed in.
    return undefined;
  }

  return { userId: claims.sub, sessionId: claims.sid, email: claims.email };
}

export interface EstablishedSession {
  readonly user: UserDoc;
  readonly session: AuthSessionDoc;
  readonly cookies: readonly string[];
}

/**
 * Starts a session and returns the cookies that carry it.
 *
 * The refresh cookie is scoped to the refresh endpoint alone. A cookie sent on
 * every request is a cookie exposed on every request, and the one thing that
 * can mint new access tokens should travel as rarely as possible.
 */
export async function startSession(
  user: UserDoc,
  request: Request,
): Promise<EstablishedSession> {
  const handle = await db();
  const users = new UserRepository(handle.db);
  const refresh = createRefreshToken();
  const now = Date.now();

  const session = await users.createSession({
    userId: user._id,
    refreshTokenHash: refresh.hash,
    sessionEpoch: user.sessionEpoch,
    expiresAt: refresh.expiresAt,
    idleExpiresAt: new Date(now + REFRESH_IDLE_TTL_MS),
    ...(request.headers.get('user-agent') !== null
      ? { userAgent: request.headers.get('user-agent') as string }
      : {}),
  });

  await users.recordSignIn(user._id);

  const secure = secureCookies();
  return {
    user,
    session,
    cookies: [
      sessionCookie(ACCESS_COOKIE, issueAccessToken({
        secret: env().AUTH_JWT_SECRET,
        issuer: issuer(),
        userId: user._id,
        sessionId: session._id,
        email: user.email,
      }), { maxAgeSeconds: ACCESS_TOKEN_TTL_SECONDS, secure }),

      sessionCookie(REFRESH_COOKIE, refresh.token, {
        maxAgeSeconds: Math.floor(REFRESH_IDLE_TTL_MS / 1_000),
        secure,
        path: REFRESH_COOKIE_PATH,
      }),
    ],
  };
}

export const signOutCookies = (): readonly string[] => {
  const secure = secureCookies();
  return [
    clearCookie(ACCESS_COOKIE, secure),
    // At the same path it was set on. A cookie is identified by name AND path,
    // so clearing this one at `/` would leave it in the browser.
    clearCookie(REFRESH_COOKIE, secure, REFRESH_COOKIE_PATH),
  ];
};

/** Attaches Set-Cookie headers to a response. */
export function withCookies(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
  return response;
}
