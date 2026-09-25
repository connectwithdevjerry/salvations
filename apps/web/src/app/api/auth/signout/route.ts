/**
 * Signing out.
 *
 * Revokes the session row as well as clearing the cookies. Clearing a cookie
 * only asks the browser to forget a credential that still works — anyone who
 * captured it keeps using it.
 */
import { UserRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, ok } from '@/lib/http';
import { readCaller, signOutCookies, withCookies } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const caller = readCaller(request);
    if (caller !== undefined) {
      const handle = await db();
      await new UserRepository(handle.db).revokeSession(caller.sessionId, 'signed_out');
    }
    // Always succeeds. Signing out twice, or while already expired, is not an
    // error the person can do anything about.
    return withCookies(ok({ signedOut: true }), signOutCookies());
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
