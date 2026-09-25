/**
 * Exchanging a refresh token for a new access token.
 *
 * Rotation on every use, and the rotation is the detection mechanism: a refresh
 * token is single-use, so a token presented twice means one of the two holders
 * stole it. We cannot tell which, so the session is killed and both are made to
 * sign in again — annoying for the legitimate one, and the only safe answer.
 */
import {
  REFRESH_COOKIE, REFRESH_IDLE_TTL_MS, createRefreshToken, hashRefreshToken, readCookie,
} from '@salvations/auth';
import { UserRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, ok } from '@/lib/http';
import { secureCookies, signOutCookies, startSession, withCookies } from '@/lib/session';

export const runtime = 'nodejs';

const EXPIRED = 'That session has expired. Sign in again.';

export async function POST(request: Request): Promise<Response> {
  try {
    const presented = readCookie(request.headers.get('cookie'), REFRESH_COOKIE);
    if (presented === undefined) {
      return errorResponse(401, 'unauthenticated', EXPIRED);
    }

    const handle = await db();
    const users = new UserRepository(handle.db);

    // Looked up by HASH, so this path never handles the token itself and the
    // index is on a value that is useless if the database leaks.
    const session = await users.findSessionByRefreshHash(hashRefreshToken(presented));
    if (session === null) {
      // Either never valid, or already rotated away — which is the reuse case.
      // Both end the same way.
      return withCookies(errorResponse(401, 'unauthenticated', EXPIRED), signOutCookies());
    }

    const now = Date.now();
    const dead =
      session.revokedAt != null ||
      session.expiresAt.getTime() < now ||
      session.idleExpiresAt.getTime() < now;

    if (dead) {
      return withCookies(errorResponse(401, 'unauthenticated', EXPIRED), signOutCookies());
    }

    const user = await users.findById(session.userId);
    if (user === null || user.disabledAt != null) {
      return withCookies(errorResponse(401, 'unauthenticated', EXPIRED), signOutCookies());
    }

    // The epoch is how one write revokes every session at once — a password
    // change, or a response to a compromise.
    if (user.sessionEpoch !== session.sessionEpoch) {
      await users.revokeSession(session._id, 'epoch_bumped');
      return withCookies(errorResponse(401, 'unauthenticated', EXPIRED), signOutCookies());
    }

    const next = createRefreshToken(now);
    const rotated = await users.rotateSession(session._id, session.refreshTokenHash, {
      refreshTokenHash: next.hash,
      idleExpiresAt: new Date(now + REFRESH_IDLE_TTL_MS),
    });

    if (!rotated) {
      // Someone else rotated it between the read and the write. Two holders of
      // one token is exactly the case that must not be papered over.
      await users.revokeSession(session._id, 'refresh_reuse');
      return withCookies(errorResponse(401, 'unauthenticated', EXPIRED), signOutCookies());
    }

    // A fresh access token and the rotated refresh, issued together.
    const issued = await startSession(user, request);
    void secureCookies();
    return withCookies(ok({ userId: user._id }), issued.cookies);
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
