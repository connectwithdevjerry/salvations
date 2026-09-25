/**
 * The code, typed back.
 *
 * Five wrong guesses spend the code; a right one spends it too and marks
 * the address verified. Nothing about the failure says whether a code is
 * live, only that this one was not it.
 */
import { z } from 'zod';
import { UserRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { userRoute } from '@/lib/route';
import { MAX_ATTEMPTS, codeHash, isCodeShaped } from '@/lib/verification';

export const runtime = 'nodejs';

const schema = z.object({ code: z.string().trim().min(1).max(12) });
const WRONG = 'That code is not right, or it has expired. Ask for a new one.';

export const POST = userRoute(async (request, userId) => {
  const input = await jsonBody(request, schema);
  const handle = await db();
  const users = new UserRepository(handle.db);
  const user = await users.findById(userId);
  if (user === null) return errorResponse(401, 'unauthenticated', 'Not signed in.');
  if (user.emailVerifiedAt != null) return ok({ verified: true });
  if (!isCodeShaped(input.code)) return errorResponse(422, 'validation_failed', 'A code is six digits.');

  const open = await users.openChallenge(userId, 'email_verification');
  if (open === null) return errorResponse(422, 'validation_failed', WRONG);

  if (open.tokenHash !== codeHash(userId, input.code)) {
    const attempts = await users.recordChallengeAttempt(open._id);
    if (attempts >= MAX_ATTEMPTS) await users.consumeChallenge(open._id);
    return errorResponse(422, 'validation_failed', WRONG);
  }

  if (!await users.consumeChallenge(open._id)) return errorResponse(422, 'validation_failed', WRONG);
  await users.markEmailVerified(userId);
  return ok({ verified: true });
});
