/**
 * Finishing a Google sign-in.
 *
 * Three ways this can go, and the third is the one worth being careful about:
 *
 *   - A known Google account → sign in.
 *   - A new Google account, new email → create the user and link it.
 *   - A new Google account whose email matches an EXISTING password account.
 *
 * The third is account takeover if handled carelessly: anyone who can get
 * Google to assert an address could claim the account behind it. It is only
 * linked when Google says the address is verified — Google owning the address
 * is the whole basis for trusting the claim.
 */
import {
  PENDING_COOKIE, clearCookie, completeSignIn, readCookie, signInExpired,
  type PendingGoogleSignIn,
} from '@salvations/auth';
import { UserRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse } from '@/lib/http';
import { PENDING_COOKIE_PATH, googleConfig, googleKeys, safeReturnTo } from '@/lib/auth-routes';
import { secureCookies, startSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Sends the browser back to the sign-in page with something it can display. */
const rejected = (reason: string, cookies: readonly string[]): Response => {
  const response = new Response(null, {
    status: 302,
    headers: { location: `/signin?error=${encodeURIComponent(reason)}` },
  });
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
  return response;
};

export async function GET(request: Request): Promise<Response> {
  // Same path it was set on, or the browser keeps it.
  const clearPending = clearCookie(PENDING_COOKIE, secureCookies(), PENDING_COOKIE_PATH);

  try {
    const config = googleConfig();
    if (config === undefined) {
      return errorResponse(501, 'unsupported', 'Sign in with Google is not configured.');
    }

    const url = new URL(request.url);
    // Google reports a refusal here rather than by failing the exchange.
    const denied = url.searchParams.get('error');
    if (denied !== null) return rejected('google_denied', [clearPending]);

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code === null || state === null) return rejected('google_incomplete', [clearPending]);

    const raw = readCookie(request.headers.get('cookie'), PENDING_COOKIE);
    if (raw === undefined) return rejected('google_expired', [clearPending]);

    let pending: PendingGoogleSignIn;
    try {
      pending = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as PendingGoogleSignIn;
    } catch {
      return rejected('google_expired', [clearPending]);
    }
    if (signInExpired(pending)) return rejected('google_expired', [clearPending]);

    // Verifies the state, exchanges the code with PKCE, and checks the identity
    // token's signature, issuer, audience and nonce.
    const identity = await completeSignIn(config, googleKeys(), pending, { code, state });

    const handle = await db();
    const users = new UserRepository(handle.db);

    const existingLink = await users.findIdentity('google', identity.subject);
    let user = existingLink === null ? null : await users.findById(existingLink.userId);

    if (existingLink !== null && user !== null) {
      await users.touchIdentity(existingLink._id, identity.email);
    } else {
      // An unverified address proves nothing. Without this check, getting
      // Google to assert an address would be enough to claim the account
      // behind it.
      if (!identity.emailVerified) return rejected('google_unverified', [clearPending]);

      const byEmail = await users.findByEmail(identity.email);
      // A password account whose address Google has just vouched for: the
      // same proof a verification link would give, so it counts as one.
      if (byEmail !== null && byEmail.emailVerifiedAt == null) await users.markEmailVerified(byEmail._id);
      user = byEmail ?? await users.create({
        email: identity.email,
        emailVerified: true,
        ...(identity.name !== undefined ? { name: identity.name } : {}),
        ...(identity.picture !== undefined ? { imageUrl: identity.picture } : {}),
      });

      await users.linkIdentity({
        userId: user._id,
        provider: 'google',
        subject: identity.subject,
        email: identity.email,
        emailVerified: identity.emailVerified,
        ...(identity.hostedDomain !== undefined ? { hostedDomain: identity.hostedDomain } : {}),
      });
    }

    if (user.disabledAt != null) return rejected('account_disabled', [clearPending]);

    const session = await startSession(user, request);
    const response = new Response(null, {
      status: 302,
      headers: { location: safeReturnTo(pending.returnTo ?? '/') },
    });
    for (const cookie of [...session.cookies, clearPending]) {
      response.headers.append('set-cookie', cookie);
    }
    return response;
  } catch {
    // Nothing from the exchange reaches the browser: it can name the client id.
    return rejected('google_failed', [clearPending]);
  }
}
