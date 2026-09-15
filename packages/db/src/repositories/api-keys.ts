/**
 * API key resolution.
 *
 * Lookup is by the non-secret prefix — an indexed read — followed by a
 * constant-time hash comparison. Scanning and comparing against every stored
 * hash would be both slow and a timing oracle.
 */
import type { Db } from 'mongodb';
import { verifyApiKey, parseApiKey } from '@salvations/crypto';
import type { Permission } from '@salvations/core';
import { PlatformDb } from '../scoped';
import type { TenantDoc } from '../documents';

export interface ApiKeyDoc extends TenantDoc {
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  createdBy: string;
  createdAt: Date;
  lastUsedAt?: Date | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

export interface ResolvedApiKey {
  readonly apiKeyId: string;
  readonly workspaceId: string;
  readonly scopes: readonly Permission[];
}

export type ApiKeyRejection =
  | 'malformed'
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'bad_secret';

export type ApiKeyResult =
  | { readonly ok: true; readonly key: ResolvedApiKey }
  | { readonly ok: false; readonly reason: ApiKeyRejection };

/**
 * A constant hash of the right shape, compared against when no key was found so
 * that the unknown and wrong-secret paths do comparable work.
 */
const DUMMY_HASH = '0'.repeat(64);

/**
 * The single client-visible outcome for EVERY failure.
 *
 * The internal reason is worth keeping for audit and metrics, but returning it
 * would tell an attacker which prefixes exist and which keys are merely
 * revoked. Callers must use this rather than mapping reasons individually.
 */
export const AUTH_FAILURE_RESPONSE = Object.freeze({
  status: 401 as const,
  code: 'unauthenticated' as const,
  message: 'Invalid API key.',
});

export class ApiKeyRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Resolves a presented key.
   *
   * The workspace is unknown until the key is resolved, so this is necessarily
   * a platform operation and declares itself as one.
   */
  async resolve(presented: string, now = new Date()): Promise<ApiKeyResult> {
    const parsed = parseApiKey(presented);
    // A malformed header costs one regex, not a database round trip.
    if (parsed === undefined) return { ok: false, reason: 'malformed' };

    const platform = new PlatformDb(this.#db, 'api-key-lookup');
    const doc = await platform
      .collection<ApiKeyDoc>('apiKeys')
      .findOne({ prefix: parsed.prefix }, { comment: platform.comment });

    if (doc === null) {
      // Hash anyway. Returning early would make an unknown prefix measurably
      // faster than a known one, which is the same enumeration oracle in the
      // time domain rather than the response body.
      verifyApiKey(presented, DUMMY_HASH);
      return { ok: false, reason: 'unknown' };
    }

    // Verify the secret BEFORE reporting revocation or expiry: otherwise the
    // endpoint answers "that key exists but is revoked" to anyone who guesses
    // a prefix.
    if (!verifyApiKey(presented, doc.keyHash)) return { ok: false, reason: 'bad_secret' };

    if (doc.revokedAt !== null && doc.revokedAt !== undefined) {
      return { ok: false, reason: 'revoked' };
    }
    if (doc.expiresAt !== null && doc.expiresAt !== undefined && doc.expiresAt <= now) {
      return { ok: false, reason: 'expired' };
    }

    return {
      ok: true,
      key: {
        apiKeyId: doc._id,
        workspaceId: doc.workspaceId,
        scopes: doc.scopes as Permission[],
      },
    };
  }

  /** Written out of band: a usage timestamp must never slow or fail a request. */
  async touch(apiKeyId: string, workspaceId: string, now = new Date()): Promise<void> {
    const platform = new PlatformDb(this.#db, 'api-key-lookup');
    await platform
      .collection<ApiKeyDoc>('apiKeys')
      .updateOne(
        { _id: apiKeyId, workspaceId },
        { $set: { lastUsedAt: now } },
        { comment: platform.comment },
      );
  }
}
