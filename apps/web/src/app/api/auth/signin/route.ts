/**
 * Signing in with an email and a password.
 */
import { DUMMY_HASH, needsRehash, hashPassword, verifyPassword } from '@salvations/auth';
import { UserRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { SIGN_IN_FAILURE, credentialsSchema } from '@/lib/auth-routes';
import { startSession, withCookies } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await jsonBody(request, credentialsSchema.omit({ name: true }));
    const handle = await db();
    const users = new UserRepository(handle.db);

    const user = await users.findByEmail(input.email);

    // Verified even when there is no account, against a hash of a password
    // nobody has. Returning early would make an unknown address measurably
    // faster and hand out a list of who is registered.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const matches = await verifyPassword(input.password, hash);

    if (user === null || user.passwordHash == null || !matches) {
      return errorResponse(401, 'unauthenticated', SIGN_IN_FAILURE);
    }
    if (user.disabledAt != null) {
      return errorResponse(403, 'forbidden', 'This account has been disabled.');
    }

    // Transparent upgrade: a password hashed under weaker parameters is
    // re-hashed now, while the plaintext is in hand and correct. There is no
    // other moment when that is possible.
    if (needsRehash(hash)) {
      await users.setPassword(user._id, await hashPassword(input.password));
    }

    const session = await startSession(user, request);
    return withCookies(ok({ userId: user._id, email: user.emailDisplay }), session.cookies);
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
