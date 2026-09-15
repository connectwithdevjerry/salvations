/**
 * Credential storage and resolution.
 *
 * Plaintext exists only inside an EphemeralSecret handed back from `resolve`,
 * and only for as long as the caller needs it. Nothing here writes plaintext,
 * returns a plain string, or logs a value.
 */
import type { Db } from 'mongodb';
import {
  EnvelopeCipher, EphemeralSecret, type CredentialBinding, type EncryptedPayload,
} from '@salvations/crypto';
import type { KeyProvider } from '@salvations/core';
import { IdPrefix, newId } from '@salvations/core';
import type { CredentialDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

/** How long a resolved secret stays readable before it must be resolved again. */
export const DEFAULT_SECRET_TTL_MS = 60_000;

export interface StoreCredentialInput {
  readonly name: string;
  readonly kind: string;
  readonly plaintext: string;
  readonly createdBy: string;
  /** Non-secret display aid, e.g. the last four characters. Never the value. */
  readonly hint?: string;
}

export class CredentialRepository {
  readonly #collection: ScopedCollection<CredentialDoc>;
  readonly #cipher: EnvelopeCipher;
  readonly #workspaceId: string;

  constructor(db: Db, workspaceId: string, keyProvider: KeyProvider) {
    this.#collection = new ScopedDb(db, workspaceId).collection<CredentialDoc>('credentials');
    this.#cipher = new EnvelopeCipher(keyProvider);
    this.#workspaceId = workspaceId;
  }

  #binding(credentialId: string, kind: string): CredentialBinding {
    return { workspaceId: this.#workspaceId, credentialId, kind };
  }

  async store(input: StoreCredentialInput): Promise<CredentialDoc> {
    // The id is minted BEFORE encrypting because it is part of the AAD: the
    // ciphertext is bound to the row it will live in, so it cannot be moved.
    const id = newId(IdPrefix.credential);
    const payload = await this.#cipher.encrypt(
      input.plaintext,
      this.#binding(id, input.kind),
    );

    return this.#collection.insertOne({
      _id: id,
      name: input.name,
      kind: input.kind,
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      authTag: payload.authTag,
      wrappedDek: payload.wrappedDek,
      keyProvider: payload.keyProvider,
      kekVersion: payload.kekVersion,
      metadata: input.hint !== undefined ? { hint: input.hint } : null,
      createdBy: input.createdBy,
      createdAt: new Date(),
      rotatedAt: null,
      revokedAt: null,
    } as never);
  }

  /**
   * Resolves a credential to a short-lived handle.
   *
   * A revoked credential resolves to nothing even if the row is still readable:
   * revocation has to take effect immediately, not when a cache expires.
   */
  async resolve(
    credentialId: string,
    ttlMs = DEFAULT_SECRET_TTL_MS,
  ): Promise<EphemeralSecret | null> {
    const doc = await this.#collection.findOne({ _id: credentialId } as never);
    if (doc === null) return null;
    if (doc.revokedAt !== null && doc.revokedAt !== undefined) return null;

    const secret = await this.#cipher.decrypt(
      this.#toPayload(doc),
      this.#binding(doc._id, doc.kind),
    );
    return new EphemeralSecret(secret.expose(), ttlMs, doc.kind);
  }

  /** Metadata only. The list view never needs — and never sees — a value. */
  async list(): Promise<Omit<CredentialDoc, 'ciphertext' | 'iv' | 'authTag' | 'wrappedDek'>[]> {
    return this.#collection.find({} as never, {
      projection: { ciphertext: 0, iv: 0, authTag: 0, wrappedDek: 0 },
    }) as never;
  }

  async revoke(credentialId: string): Promise<void> {
    await this.#collection.updateOne(
      { _id: credentialId } as never,
      { $set: { revokedAt: new Date() } } as never,
    );
  }

  /**
   * Re-wraps every credential still under a retired KEK.
   *
   * Plaintext is never decrypted, so a rotation job needs no permission to read
   * the secrets it rotates. Safe to re-run: already-current rows are skipped.
   */
  async rewrapStale(limit = 100): Promise<{ rewrapped: number; remaining: number }> {
    const stale = await this.#collection.find(
      { kekVersion: { $ne: this.#cipher.currentKekVersion }, revokedAt: null } as never,
      { limit },
    );

    let rewrapped = 0;
    for (const doc of stale) {
      const next = await this.#cipher.rewrap(this.#toPayload(doc));
      const result = await this.#collection.updateOne(
        // Guarded on the version we read, so a concurrent rotation does not
        // double-wrap or clobber a newer wrapping.
        { _id: doc._id, kekVersion: doc.kekVersion } as never,
        {
          $set: {
            wrappedDek: next.wrappedDek,
            keyProvider: next.keyProvider,
            kekVersion: next.kekVersion,
            rotatedAt: new Date(),
          },
        } as never,
      );
      if (result.matchedCount === 1) rewrapped += 1;
    }

    const remaining = await this.#collection.countDocuments({
      kekVersion: { $ne: this.#cipher.currentKekVersion },
      revokedAt: null,
    } as never);

    return { rewrapped, remaining };
  }

  #toPayload(doc: CredentialDoc): EncryptedPayload {
    return {
      ciphertext: doc.ciphertext,
      iv: doc.iv,
      authTag: doc.authTag,
      wrappedDek: doc.wrappedDek,
      keyProvider: doc.keyProvider,
      kekVersion: doc.kekVersion,
    };
  }
}
