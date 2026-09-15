/**
 * Better Auth configuration.
 *
 * Auth is self-hosted and owns its collections in our own database, so there is
 * no identity vendor to migrate away from, and session revocation is immediate
 * and global rather than waiting for a token to expire somewhere else.
 */
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { db } from './db';
import { env } from './env';

async function createAuth() {
  const e = env();
  const handle = await db();

  return betterAuth({
    database: mongodbAdapter(handle.db),
    secret: e.BETTER_AUTH_SECRET,
    baseURL: e.BETTER_AUTH_URL,

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: e.NODE_ENV === 'production',
      // Argon2id is the library default; the length floor is stated here so a
      // future relaxation has to be deliberate.
      minPasswordLength: 12,
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      // Rolling refresh: an active session stays alive, an idle one lapses.
      updateAge: 60 * 60 * 24,
      // No cookie cache: a cached session survives revocation for its lifetime,
      // which defeats immediate revocation.
      cookieCache: { enabled: false },
    },

    advanced: {
      useSecureCookies: e.NODE_ENV === 'production',
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
    },

    rateLimit: { enabled: true, window: 60, max: 20 },
  });
}

export type AuthInstance = Awaited<ReturnType<typeof createAuth>>;

// The PROMISE is cached, not the resolved value: two concurrent requests on a
// cold instance would otherwise each build an adapter and open a connection.
let cached: Promise<AuthInstance> | undefined;

export function auth(): Promise<AuthInstance> {
  cached ??= createAuth().catch((error: unknown) => {
    // Never cache a failed construction — the next request must retry.
    cached = undefined;
    throw error;
  });
  return cached;
}
