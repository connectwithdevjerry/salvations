/**
 * Password hashing.
 *
 * scrypt from `node:crypto`, not a hand-written KDF and not a dependency.
 * Writing a password hash yourself is how people end up with one round of
 * SHA-256; adding a library for something Node already ships well is a supply
 * chain surface for no gain.
 *
 * scrypt rather than PBKDF2 because it is memory-hard: a GPU or ASIC farm gets
 * far less advantage over an ordinary server. Argon2id would be marginally
 * preferable and is not in the standard library, so it would cost a native
 * dependency — scrypt at these parameters is the better trade.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Cost parameters.
 *
 * N=2^15 with r=8 needs roughly 32 MB and about 100 ms on a current server —
 * slow enough that offline guessing is expensive, fast enough that a sign-in
 * does not feel broken. `maxmem` is raised above the default because the
 * default rejects these parameters outright.
 */
const PARAMS = { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const SCHEME = 'scrypt';

/**
 * The stored form: `scrypt$N$r$p$salt$hash`, both base64url.
 *
 * Parameters travel WITH the hash. Raising the cost later must not invalidate
 * every existing password, and a hash that does not record how it was made
 * cannot be verified after the constant changes.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plaintext.normalize('NFKC'), salt, KEY_BYTES, PARAMS);
  return [
    SCHEME, PARAMS.N, PARAMS.r, PARAMS.p,
    salt.toString('base64url'), derived.toString('base64url'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing for anything malformed: a corrupt row must
 * not be distinguishable from a wrong password, or the difference becomes an
 * oracle.
 */
export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile row could otherwise ask for parameters that exhaust memory — a
  // denial of service triggered by a sign-in attempt.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64url');
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(plaintext.normalize('NFKC'), salt, expected.length, {
      N, r, p, maxmem: PARAMS.maxmem,
    });
  } catch {
    return false;
  }

  // Constant time: a length-aware early exit leaks how much of the hash matched.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when a stored hash was made with weaker parameters than we use now. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return true;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
}

/**
 * A hash of a password nobody has.
 *
 * Verified against when an email does not exist, so a sign-in for an unknown
 * address costs the same time as one for a known address. Without it, response
 * time alone tells an attacker which addresses are registered.
 */
export const DUMMY_HASH = await hashPassword(randomBytes(32).toString('base64url'));
