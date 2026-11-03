/**
 * The site password's form: GET shows it, POST checks it and sets the cookie.
 * Only reached when SITE_PASSWORD is set; see lib/site-gate.ts.
 */
import { NextResponse } from 'next/server';
import { SITE_GATE_COOKIE, SITE_GATE_MAX_AGE, gateToken, safeNext, sameText } from '@/lib/site-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(next: string, wrong: boolean): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>YASHAYAH</title>
<style>
:root{--bg:#fbfbfa;--card:#fff;--text:#111;--muted:#666;--border:#ddd;--accent:#2f5be7;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#05070b;--card:#0d1117;--text:#eee;--muted:#999;--border:#2a2f37;--accent:#5b82ff;--bad:#ff6b6b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,sans-serif}
form{width:100%;max-width:340px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px}
h1{margin:0 0 4px;font-size:20px;letter-spacing:.04em}p{margin:0 0 18px;color:var(--muted)}
input{width:100%;padding:11px 12px;border:1px solid var(--border);border-radius:9px;background:transparent;color:inherit;font:inherit}
button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.bad{color:var(--bad);margin:10px 0 0}
</style></head><body>
<form method="post" action="/unlock">
<h1>YASHAYAH</h1><p>This site is private. Enter the password to continue.</p>
<input type="hidden" name="next" value="${escape(next)}">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required aria-label="Password">
<button type="submit">Continue</button>
${wrong ? '<p class="bad">That password is not right.</p>' : ''}
</form></body></html>`;
  return new Response(html, {
    status: wrong ? 401 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

export function GET(request: Request): Response {
  return page(safeNext(new URL(request.url).searchParams.get('next')), false);
}

export async function POST(request: Request): Promise<Response> {
  const password = process.env.SITE_PASSWORD;
  const form = await request.formData().catch(() => undefined);
  const next = safeNext(typeof form?.get('next') === 'string' ? form.get('next') as string : null);
  if (password === undefined || password === '') return NextResponse.redirect(new URL(next, request.url), 303);

  const given = typeof form?.get('password') === 'string' ? form.get('password') as string : '';
  if (!sameText(await gateToken(given), await gateToken(password))) {
    // A pause, so guessing is slow.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return page(next, true);
  }
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(SITE_GATE_COOKIE, await gateToken(password), {
    httpOnly: true, secure: new URL(request.url).protocol === 'https:', sameSite: 'lax', path: '/', maxAge: SITE_GATE_MAX_AGE,
  });
  return response;
}
