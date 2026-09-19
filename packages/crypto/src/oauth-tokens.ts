/**
 * Opaque tokens for the platform's own authorization server, and PKCE.
 *
 * Every artefact an OAuth client is handed — authorization code, access token,
 * refresh token — is random, prefixed so a log line says what leaked, and
 * stored only as a hash. There is nothing to decode and no key to rotate; a
 * token is a database row or it is nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { safeEqual } from './envelope';

export type OpaqueTokenKind = 'code' | 'access' | 'refresh';

const PREFIXES: Readonly<Record<OpaqueTokenKind, string>> = {
  code: 'hive_ac_',
  access: 'hive_at_',
  refresh: 'hive_rt_',
};

const TOKEN_BYTES = 32;

export interface MintedOpaqueToken {
  readonly kind: OpaqueTokenKind;
  /** Handed to the client once. Never stored. */
  readonly token: string;
  /** What is stored, and what a presented token is compared against. */
  readonly hash: string;
}

export const hashOpaqueToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export function mintOpaqueToken(kind: OpaqueTokenKind): MintedOpaqueToken {
  const token = `${PREFIXES[kind]}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { kind, token, hash: hashOpaqueToken(token) };
}

/** Which kind a presented token claims to be, from its prefix. Nothing is verified. */
export function opaqueTokenKind(token: string): OpaqueTokenKind | undefined {
  for (const [kind, prefix] of Object.entries(PREFIXES) as [OpaqueTokenKind, string][]) {
    if (token.startsWith(prefix) && token.length > prefix.length) return kind;
  }
  return undefined;
}

/** S256, the only PKCE method offered: base64url(sha256(verifier)). */
export const pkceChallengeOf = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/**
 * RFC 7636 §4.1: 43–128 characters from the unreserved set. A verifier outside
 * that is refused before it is hashed, so a malformed one cannot pass by
 * happening to hash to the right value.
 */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  return safeEqual(pkceChallengeOf(verifier), challenge);
}
