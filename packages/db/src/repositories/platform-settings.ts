/**
 * The deployment's own settings.
 *
 * A workspace's keys belong to that workspace and live with its credentials.
 * These belong to whoever runs the site — today, the OpenAI key the public
 * voice demo on the landing page runs on — so they belong to no workspace.
 *
 * The secret is encrypted under the same envelope as every workspace
 * credential, bound to its own row, and never read back to a browser: the
 * admin card sees the last four characters and who set it, nothing more.
 */
import type { Db } from 'mongodb';
import { EnvelopeCipher, EphemeralSecret, type CredentialBinding } from '@salvations/crypto';
import type { KeyProvider } from '@salvations/core';
import { bytes } from '../bytes';
import { PlatformDb } from '../scoped';

/** The one secret this collection holds so far. */
export type PlatformSecretName = 'openai';

export interface PlatformSecretDoc {
  _id: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  wrappedDek: Uint8Array;
  keyProvider: string;
  kekVersion: number;
  /** The last four characters. Never the value. */
  hint: string;
  updatedBy: string;
  updatedAt: Date;
}

export interface PlatformSecretSummary {
  readonly hint: string;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

/** A plain-text secret is resolved for this long, then has to be resolved again. */
const SECRET_TTL_MS = 60_000;

export class PlatformSettingsRepository {
  readonly #db: Db;
  readonly #cipher: EnvelopeCipher;

  constructor(db: Db, keyProvider: KeyProvider) {
    this.#db = db;
    this.#cipher = new EnvelopeCipher(keyProvider);
  }

  #settings() {
    return new PlatformDb(this.#db, 'platform-settings').collection<PlatformSecretDoc>('platformSettings');
  }

  /**
   * Bound to its row like a workspace credential is, under a workspace id no
   * workspace can have, so a platform ciphertext cannot be moved into a
   * workspace's credentials and decrypt there, or the other way round.
   */
  #binding(name: PlatformSecretName): CredentialBinding {
    return { workspaceId: 'platform', credentialId: `secret:${name}`, kind: name };
  }

  async setSecret(name: PlatformSecretName, plaintext: string, updatedBy: string): Promise<PlatformSecretSummary> {
    const payload = await this.#cipher.encrypt(plaintext, this.#binding(name));
    const summary = { hint: plaintext.slice(-4), updatedBy, updatedAt: new Date() };
    await this.#settings().replaceOne(
      { _id: `secret:${name}` },
      {
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        authTag: payload.authTag,
        wrappedDek: payload.wrappedDek,
        keyProvider: payload.keyProvider,
        kekVersion: payload.kekVersion,
        ...summary,
      },
      { upsert: true },
    );
    return summary;
  }

  async describeSecret(name: PlatformSecretName): Promise<PlatformSecretSummary | null> {
    const doc = await this.#settings().findOne(
      { _id: `secret:${name}` },
      { projection: { hint: 1, updatedBy: 1, updatedAt: 1 } },
    );
    return doc === null ? null : { hint: doc.hint, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt };
  }

  async resolveSecret(name: PlatformSecretName): Promise<EphemeralSecret | null> {
    const doc = await this.#settings().findOne({ _id: `secret:${name}` });
    if (doc === null) return null;
    const secret = await this.#cipher.decrypt(
      {
        ciphertext: bytes(doc.ciphertext),
        iv: bytes(doc.iv),
        authTag: bytes(doc.authTag),
        wrappedDek: bytes(doc.wrappedDek),
        keyProvider: doc.keyProvider,
        kekVersion: doc.kekVersion,
      },
      this.#binding(name),
    );
    return new EphemeralSecret(secret.expose(), SECRET_TTL_MS, name);
  }

  async clearSecret(name: PlatformSecretName): Promise<void> {
    await this.#settings().deleteOne({ _id: `secret:${name}` });
  }
}

/**
 * Counting what the public demo spends.
 *
 * One row per counter and window, incremented atomically, and reaped by a TTL
 * index once its window has passed. The increment comes first and the check
 * after, so two requests racing for the last slot cannot both get it.
 */
export interface DemoUsageDoc {
  _id: string;
  count: number;
  expiresAt: Date;
}

export class DemoUsageRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Counts one more use of `key` in its window and says whether it is still within `limit`. */
  async take(key: string, limit: number, windowMs: number, now = Date.now()): Promise<boolean> {
    const window = Math.floor(now / windowMs);
    const row = await new PlatformDb(this.#db, 'platform-settings')
      .collection<DemoUsageDoc>('demoUsage')
      .findOneAndUpdate(
        { _id: `${key}:${window}` },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * windowMs) } },
        { upsert: true, returnDocument: 'after' },
      );
    return (row?.count ?? 1) <= limit;
  }
}
