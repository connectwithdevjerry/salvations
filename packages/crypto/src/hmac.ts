/**
 * Request signing for internal endpoints (/api/internal/*).
 *
 * The run executor and the sweeper must be reachable over HTTP — that is how a
 * serverless slice hands off to the next one — but they must NOT be reachable
 * with a user session cookie. A cookie-authenticated execute endpoint would let
 * any logged-in user drive arbitrary runs. So these endpoints accept only an
 * HMAC over the request, using a secret distinct from every other secret.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './envelope';

export const SIGNATURE_HEADER = 'x-salvations-signature';
export const TIMESTAMP_HEADER = 'x-salvations-timestamp';

/** Rejects replays of a captured request outside this window. */
export const DEFAULT_SKEW_MS = 60_000;

export interface SignedHeaders {
  readonly [SIGNATURE_HEADER]: string;
  readonly [TIMESTAMP_HEADER]: string;
}

const canonical = (method: string, path: string, timestamp: string, body: string): string =>
  // Newline-delimited with explicit lengths: without them, moving a character
  // between adjacent fields would produce the same string and the same MAC.
  [
    `v1`,
    method.toUpperCase(),
    path,
    timestamp,
    `${body.length}:${body}`,
  ].join('\n');

export function sign(
  secret: string,
  method: string,
  path: string,
  body: string,
  timestamp: number = Date.now(),
): SignedHeaders {
  const ts = String(timestamp);
  const mac = createHmac('sha256', secret).update(canonical(method, path, ts, body)).digest('hex');
  return { [SIGNATURE_HEADER]: `v1=${mac}`, [TIMESTAMP_HEADER]: ts };
}

export type VerifyFailure =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'malformed_signature'
  | 'stale_timestamp'
  | 'bad_signature';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export function verify(
  secret: string,
  method: string,
  path: string,
  body: string,
  headers: { signature?: string | null; timestamp?: string | null },
  options: { skewMs?: number; now?: number } = {},
): VerifyResult {
  const signature = headers.signature;
  const timestamp = headers.timestamp;
  if (signature === undefined || signature === null || signature === '') {
    return { ok: false, reason: 'missing_signature' };
  }
  if (timestamp === undefined || timestamp === null || timestamp === '') {
    return { ok: false, reason: 'missing_timestamp' };
  }
  if (!signature.startsWith('v1=')) return { ok: false, reason: 'malformed_signature' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed_signature' };

  const now = options.now ?? Date.now();
  const skew = options.skewMs ?? DEFAULT_SKEW_MS;
  // Both directions: a future timestamp is as suspicious as an old one.
  if (Math.abs(now - ts) > skew) return { ok: false, reason: 'stale_timestamp' };

  const expected = createHmac('sha256', secret)
    .update(canonical(method, path, timestamp, body))
    .digest('hex');

  return safeEqual(signature.slice(3), expected)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}

export const generateHmacSecret = (): string => randomBytes(32).toString('base64');
