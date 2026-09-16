/**
 * Beginning a Google sign-in.
 *
 * The state, nonce and PKCE verifier are minted here and parked in a
 * short-lived httpOnly cookie. They have to survive a redirect to Google and
 * back, and the browser is the only thing that makes that round trip — but they
 * must never be readable by script, which is what httpOnly buys.
 */
import { PENDING_COOKIE, authorizationUrl, beginSignIn, sessionCookie } from '@salvations/auth';
import { SIGN_IN_TTL_MS } from '@salvations/auth';
import { errorResponse } from '@/lib/http';
import { PENDING_COOKIE_PATH, googleConfig, googleKeys, safeReturnTo } from '@/lib/auth-routes';
import { secureCookies } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const config = googleConfig();
    if (config === undefined) {
      return errorResponse(
        501, 'unsupported',
        'Sign in with Google is not configured for this deployment.',
      );
    }

    const url = new URL(request.url);
    const pending = beginSignIn({
      // Same-site paths only; an absolute URL here is the open redirect that
      // makes a phishing link look like it came from us.
      returnTo: safeReturnTo(url.searchParams.get('returnTo')),
    });

    const metadata = await googleKeys().metadata();
    const target = authorizationUrl(config, metadata, pending, {
      // Always offer the account chooser: silently reusing whichever Google
      // account the browser happens to hold is how people sign in as the wrong
      // person and never notice.
      prompt: 'select_account',
    });

    const response = new Response(null, { status: 302, headers: { location: target } });
    response.headers.append('set-cookie', sessionCookie(
      PENDING_COOKIE,
      Buffer.from(JSON.stringify(pending)).toString('base64url'),
      {
        maxAgeSeconds: Math.floor(SIGN_IN_TTL_MS / 1_000),
        secure: secureCookies(),
        path: PENDING_COOKIE_PATH,
      },
    ));
    return response;
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
