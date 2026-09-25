/**
 * Shared pieces of the authentication routes.
 */
import { z } from 'zod';
import { GoogleKeys, type GoogleConfig } from '@salvations/auth';
import { env } from './env';
import { issuer } from './session';

/**
 * The password floor.
 *
 * Length only. Composition rules ("one capital, one symbol") push people toward
 * `Password1!` and measurably reduce entropy; length is what actually helps.
 */
export const MIN_PASSWORD_LENGTH = 12;

export const credentialsSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(4_096),
  name: z.string().trim().min(1).max(120).optional(),
});

/**
 * One message for every sign-in failure.
 *
 * Distinguishing "no such account" from "wrong password" turns the form into an
 * account-enumeration oracle, and the pairing with a dummy hash verification
 * keeps the TIMING the same too — saying the same thing slower for unknown
 * addresses would leak exactly what the message refuses to.
 */
export const SIGN_IN_FAILURE = 'That email and password do not match an account.';

/**
 * The path the in-flight sign-in cookie lives at.
 *
 * Named once because set and clear must agree; a mismatch leaves the cookie in
 * the browser and is invisible until a stale one breaks the next attempt.
 */
export const PENDING_COOKIE_PATH = '/api/auth/google';

/** Configured only when both halves are present; the env schema enforces that. */
export function googleConfig(): GoogleConfig | undefined {
  const e = env();
  if (e.GOOGLE_CLIENT_ID === undefined || e.GOOGLE_CLIENT_SECRET === undefined) return undefined;
  return {
    clientId: e.GOOGLE_CLIENT_ID,
    clientSecret: e.GOOGLE_CLIENT_SECRET,
    redirectUri: `${issuer()}/api/auth/google/callback`,
  };
}

/** Discovery and key material, cached for the life of the process. */
const store = globalThis as typeof globalThis & { __googleKeys__?: GoogleKeys };
export const googleKeys = (): GoogleKeys => (store.__googleKeys__ ??= new GoogleKeys());

/**
 * Where to send someone after signing in.
 *
 * Only a same-site path is ever honoured. An absolute URL here is the open
 * redirect that makes a phishing link look like it came from us.
 */
export function safeReturnTo(raw: string | null): string {
  if (raw === null || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}
