/**
 * Who am I?
 *
 * Answers 200 with `null` rather than 401 when nobody is signed in: for the UI
 * this is a question, not a failed authorisation, and treating the ordinary
 * signed-out case as an error makes every client special-case it.
 */
import { UserRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, ok } from '@/lib/http';
import { readCaller } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const caller = readCaller(request);
    if (caller === undefined) return ok({ user: null });

    const handle = await db();
    const user = await new UserRepository(handle.db).findById(caller.userId);
    if (user === null || user.disabledAt != null) return ok({ user: null });

    return ok({
      user: {
        id: user._id,
        email: user.emailDisplay,
        name: user.name ?? undefined,
        imageUrl: user.imageUrl ?? undefined,
        emailVerified: user.emailVerifiedAt != null,
      },
    });
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
