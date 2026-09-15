/**
 * API key minting and verification.
 *
 * Format: sk_<env>_<prefix>_<secret>
 *
 * The prefix is a non-secret, indexed lookup handle, so verification is a
 * single indexed read followed by a constant-time comparison — rather than
 * scanning and comparing against every stored hash. Only the hash of the full
 * key is persisted; the key itself is shown once, at creation.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Secret } from './secret.js';
import { safeEqual } from './envelope.js';

const PREFIX_BYTES = 6;
const SECRET_BYTES = 24;

export type KeyEnvironment = 'live' | 'test';

export interface MintedApiKey {
  /** Shown to the user exactly once. */
  readonly key: Secret;
  readonly prefix: string;
  readonly keyHash: string;
}

const base62 = (bytes: Buffer): string =>
  bytes.toString('base64url').replace(/[-_]/g, '').slice(0, bytes.length);

export const hashApiKey = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex');

export function mintApiKey(environment: KeyEnvironment = 'live'): MintedApiKey {
  const prefix = base62(randomBytes(PREFIX_BYTES * 2)).slice(0, 12);
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const key = `sk_${environment}_${prefix}_${secret}`;
  return { key: new Secret(key, 'api_key'), prefix, keyHash: hashApiKey(key) };
}

export interface ParsedApiKey {
  readonly environment: KeyEnvironment;
  readonly prefix: string;
}

/**
 * Parses without verifying. Returns undefined for anything malformed, so a
 * garbage Authorization header costs one regex rather than a database round
 * trip.
 *
 * Matched positionally rather than by splitting on '_': the secret is base64url,
 * whose alphabet includes '_' and '-', so a naive split yields a variable number
 * of parts and fails for roughly a third of randomly generated keys. The prefix
 * is deliberately restricted to alphanumerics so the third separator is
 * unambiguous.
 */
const KEY_PATTERN = /^sk_(live|test)_([A-Za-z0-9]{1,32})_(.+)$/;

export function parseApiKey(key: string): ParsedApiKey | undefined {
  const match = KEY_PATTERN.exec(key);
  if (match === null) return undefined;
  return { environment: match[1] as KeyEnvironment, prefix: match[2] as string };
}

/** Constant-time verification against the stored hash. */
export const verifyApiKey = (presented: string, storedHash: string): boolean =>
  safeEqual(hashApiKey(presented), storedHash);
