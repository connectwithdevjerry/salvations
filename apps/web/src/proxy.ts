/**
 * The site password, when SITE_PASSWORD is set. See lib/site-gate.ts.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SITE_GATE_COOKIE, SITE_GATE_PATH, gateToken, passesWithoutPassword, sameText } from '@/lib/site-gate';

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const password = process.env.SITE_PASSWORD;
  if (password === undefined || password === '') return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (passesWithoutPassword(pathname, request.headers.get('authorization'))) return NextResponse.next();

  const cookie = request.cookies.get(SITE_GATE_COOKIE)?.value;
  if (cookie !== undefined && sameText(cookie, await gateToken(password))) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: { code: 'unauthenticated', message: 'This site is private. Open it in a browser and enter the password.' } },
      { status: 401, headers: { 'x-robots-tag': 'noindex' } },
    );
  }
  const to = new URL(SITE_GATE_PATH, request.url);
  to.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(to);
}

export const config = {
  // Everything but the framework's own static files and the icons.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png).*)'],
};
