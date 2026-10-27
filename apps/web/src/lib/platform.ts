/**
 * The site owner's side of the deployment.
 *
 * A workspace's admins run their workspace. Somebody also runs the site
 * itself, and pays for what the public pages do: today, the voice demo on
 * the landing page, which talks on the site owner's own OpenAI key. Who that
 * is comes from the environment, by email, and the address has to be
 * verified to count — anyone can type an email into a sign-up form.
 */
import { PlatformSettingsRepository, UserRepository, type Database } from '@salvations/db';
import { env } from './env';
import { errorResponse } from './http';
import { keyProvider } from './keys';
import { db } from './db';
import { readCaller, type Caller } from './session';

/** The emails named in PLATFORM_ADMIN_EMAILS, lowercased. */
export function platformAdminEmails(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e !== ''),
  );
}

/** Whether this signed-in person runs the site. */
export async function isPlatformAdmin(database: Database, caller: Caller): Promise<boolean> {
  const operators = platformAdminEmails(env().PLATFORM_ADMIN_EMAILS);
  if (!operators.has(caller.email.trim().toLowerCase())) return false;
  // The token's email is what was true when it was signed; the row is what is
  // true now, and only a verified address counts.
  const user = await new UserRepository(database).findById(caller.userId);
  return user !== null && user.emailVerifiedAt != null && operators.has(user.email);
}

export const platformSettings = (database: Database) =>
  new PlatformSettingsRepository(database, keyProvider());

/**
 * A route only the site's operators can reach.
 *
 * Everyone else gets a 404, not a 403: the page that calls it hides the card
 * on any refusal, and there is nothing here worth confirming exists.
 */
export function platformRoute(
  handler: (ctx: { request: Request; caller: Caller; database: Database }) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const caller = readCaller(request);
      if (caller === undefined) return errorResponse(401, 'unauthenticated', 'Not signed in.');
      const { db: database } = await db();
      if (!(await isPlatformAdmin(database, caller))) {
        return errorResponse(404, 'not_found', 'Not found.');
      }
      return await handler({ request, caller, database });
    } catch (error) {
      return errorResponse.fromUnknown(error);
    }
  };
}
