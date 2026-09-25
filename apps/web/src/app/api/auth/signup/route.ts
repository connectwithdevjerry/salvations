/**
 * Creating an account with an email and a password.
 */
import { hashPassword } from '@salvations/auth';
import { UserRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { credentialsSchema } from '@/lib/auth-routes';
import { startSession, withCookies } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await jsonBody(request, credentialsSchema);
    const handle = await db();
    const users = new UserRepository(handle.db);

    // Hashed BEFORE the insert, so the time this takes does not depend on
    // whether the address was already registered.
    const passwordHash = await hashPassword(input.password);

    let user;
    try {
      user = await users.create({
        email: input.email,
        passwordHash,
        ...(input.name !== undefined ? { name: input.name } : {}),
      });
    } catch (caught) {
      // The unique index, not a prior read: two concurrent sign-ups would both
      // see "not taken" and one would overwrite the other.
      if ((caught as { code?: number }).code === 11000) {
        return errorResponse(
          409, 'conflict',
          'An account already exists for that email. Try signing in instead.',
        );
      }
      throw caught;
    }

    const session = await startSession(user, request);
    return withCookies(
      ok({ userId: user._id, email: user.emailDisplay }, 201),
      session.cookies,
    );
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
