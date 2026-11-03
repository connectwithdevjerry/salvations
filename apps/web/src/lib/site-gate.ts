/**
 * A password in front of the whole site, for a deployment that is not public.
 *
 * Set SITE_PASSWORD and every page and every browser call asks for it once;
 * the browser then keeps a cookie for a month. Unset, nothing is gated: local
 * development, CI and any public deployment are as they were.
 *
 * What is let through is what no person is at the other end of: health
 * probes, the scheduler, vendors' webhooks, and MCP and OAuth clients. Each
 * of those already proves itself with a signature, a secret or a key. The
 * landing page's voice demo is never let through, whatever it is sent with.
 */

export const SITE_GATE_COOKIE = 'site_gate';
export const SITE_GATE_PATH = '/unlock';
export const SITE_GATE_MAX_AGE = 30 * 24 * 3600;

const MACHINE_PREFIXES = [
  '/api/health',
  '/api/internal/',
  '/api/channels/',
  '/api/billing/webhook',
  '/api/media/',
  '/api/oauth/register',
  '/api/oauth/token',
  '/.well-known/',
  '/mcp/',
] as const;

/** Whether a request may skip the password. */
export function passesWithoutPassword(pathname: string, authorization: string | null): boolean {
  if (pathname === SITE_GATE_PATH) return true;
  if (pathname.startsWith('/api/demo/')) return false;
  if (pathname === '/api/demo') return false;
  if (MACHINE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (/^\/api\/workspaces\/[^/]+\/mcp\/bindings\/[^/]+\/gateway$/.test(pathname)) return true;
  // An API key or token: the route checks it. Pages are never let through this way.
  return pathname.startsWith('/api/') && authorization !== null && /^Bearer\s+\S/.test(authorization);
}

/** What the cookie holds: a digest of the password, so changing it signs everyone out. */
export async function gateToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`site-gate:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Equal strings, compared without stopping at the first difference. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Only a path on this site, so the form cannot be used to send someone elsewhere. */
export function safeNext(next: string | null): string {
  return next !== null && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}
