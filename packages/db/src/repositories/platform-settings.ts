/**
 * The deployment's own settings, kept in the database rather than only in
 * the environment: the keys to its Slack and Discord apps, its Meta app,
 * its own model key. An operator changes these from a dashboard, and the
 * change takes effect without a redeploy.
 *
 * A secret setting is envelope-encrypted exactly as a workspace credential
 * is, under the same KEK, bound to its own key so a ciphertext cannot be
 * moved from one setting to another. A setting that is not secret (a client
 * id, a configuration id, a model name) is stored in the clear so it can be
 * shown back. Plaintext of a secret leaves this file only inside a value
 * the caller asked for by name, never in a list.
 *
 * Global by nature, not tenant data: these belong to the deployment and to
 * no workspace, which is why the collection is global and every read says
 * so.
 */
import type { Db } from 'mongodb';
import { EnvelopeCipher, type CredentialBinding, type EncryptedPayload } from '@salvations/crypto';
import type { KeyProvider } from '@salvations/core';
import { bytes } from '../bytes';
import { PlatformDb } from '../scoped';

export interface PlatformSettingDoc {
  /** The setting's name, e.g. `slack_client_secret`. */
  _id: string;
  secret: boolean;
  /** The value, for a setting that is not secret. */
  value?: string | null;
  ciphertext?: Uint8Array | null;
  iv?: Uint8Array | null;
  authTag?: Uint8Array | null;
  wrappedDek?: Uint8Array | null;
  keyProvider?: string | null;
  kekVersion?: number | null;
  /** The last four characters of a secret, or the whole of a value that is not one. Never the secret. */
  hint: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface PlatformSettingSummary {
  readonly key: string;
  readonly secret: boolean;
  readonly hint: string;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

const BINDING_WORKSPACE = 'platform';
const KIND = 'platform_setting';

export class PlatformSettingsRepository {
  readonly #platform: PlatformDb;
  readonly #cipher: EnvelopeCipher;

  constructor(db: Db, keyProvider: KeyProvider) {
    this.#platform = new PlatformDb(db, 'platform-settings');
    this.#cipher = new EnvelopeCipher(keyProvider);
  }

  get #collection() {
    return this.#platform.collection<PlatformSettingDoc>('platformSettings');
  }

  #binding(key: string): CredentialBinding {
    return { workspaceId: BINDING_WORKSPACE, credentialId: key, kind: KIND };
  }

  /** Writes a setting, replacing whatever was there. */
  async set(key: string, value: string, options: { secret: boolean; updatedBy: string }): Promise<void> {
    const now = new Date();
    const doc: PlatformSettingDoc = options.secret
      ? {
        _id: key, secret: true, value: null,
        ...(await this.#encrypted(key, value)),
        hint: `••••${value.slice(-4)}`, updatedAt: now, updatedBy: options.updatedBy,
      }
      : {
        _id: key, secret: false, value,
        ciphertext: null, iv: null, authTag: null, wrappedDek: null, keyProvider: null, kekVersion: null,
        hint: value, updatedAt: now, updatedBy: options.updatedBy,
      };
    await this.#collection.replaceOne({ _id: key } as never, doc as never, { upsert: true, comment: this.#platform.comment });
  }

  async clear(key: string): Promise<boolean> {
    const result = await this.#collection.deleteOne({ _id: key } as never, { comment: this.#platform.comment });
    return result.deletedCount === 1;
  }

  /** Every setting, decrypted: what the deployment currently holds. */
  async readAll(): Promise<ReadonlyMap<string, string>> {
    const docs = await this.#collection.find({} as never, { comment: this.#platform.comment }).toArray();
    const out = new Map<string, string>();
    for (const doc of docs) {
      if (!doc.secret) {
        if (typeof doc.value === 'string') out.set(doc._id, doc.value);
        continue;
      }
      const secret = await this.#cipher.decrypt(this.#toPayload(doc), this.#binding(doc._id));
      out.set(doc._id, secret.expose());
    }
    return out;
  }

  /** Metadata only: which settings are set, with hints. No secret leaves here. */
  async list(): Promise<PlatformSettingSummary[]> {
    const docs = await this.#collection.find({} as never, {
      projection: { ciphertext: 0, iv: 0, authTag: 0, wrappedDek: 0 }, comment: this.#platform.comment,
    }).toArray();
    return docs.map((doc) => ({ key: doc._id, secret: doc.secret, hint: doc.hint, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy }));
  }

  async #encrypted(key: string, value: string): Promise<Pick<PlatformSettingDoc, 'ciphertext' | 'iv' | 'authTag' | 'wrappedDek' | 'keyProvider' | 'kekVersion'>> {
    const payload = await this.#cipher.encrypt(value, this.#binding(key));
    return {
      ciphertext: payload.ciphertext, iv: payload.iv, authTag: payload.authTag,
      wrappedDek: payload.wrappedDek, keyProvider: payload.keyProvider, kekVersion: payload.kekVersion,
    };
  }

  #toPayload(doc: PlatformSettingDoc): EncryptedPayload {
    return {
      ciphertext: bytes(doc.ciphertext), iv: bytes(doc.iv), authTag: bytes(doc.authTag), wrappedDek: bytes(doc.wrappedDek),
      keyProvider: doc.keyProvider ?? '', kekVersion: doc.kekVersion ?? 1,
    };
  }
}
