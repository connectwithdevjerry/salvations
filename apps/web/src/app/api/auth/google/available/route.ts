/**
 * Whether Google sign-in is configured.
 *
 * A boolean and nothing else. The client id is not a secret, but publishing it
 * from an endpoint anyone can call invites it into places it does not belong —
 * and the UI only needs to know whether to draw a button.
 */
import { ok } from '@/lib/http';
import { googleConfig } from '@/lib/auth-routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return ok({ available: googleConfig() !== undefined });
}
