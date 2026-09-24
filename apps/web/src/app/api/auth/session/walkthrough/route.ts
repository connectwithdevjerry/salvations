/**
 * "I have seen the walkthrough."
 *
 * Kept on the account rather than only in the browser, so a new laptop or a
 * cleared cache does not replay the tour to somebody who has used the product
 * for months. Signed-out callers get a 401: there is no account to remember
 * it on.
 */
import { UserRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, ok } from '@/lib/http';
import { readCaller } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const caller = readCaller(request);
    if (caller === undefined) return errorResponse(401, 'unauthenticated', 'Sign in first.');

    const handle = await db();
    await new UserRepository(handle.db).markWalkthroughSeen(caller.userId);
    return ok({ seen: true });
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
