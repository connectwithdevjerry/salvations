/**
 * KeyProvider implementations.
 *
 * The KEK never leaves the provider. A provider holds the CURRENT version for
 * wrapping and every retired version for unwrapping, so rotation is incremental
 * and online: new writes use the new key, old rows keep working, and a
 * background re-wrap catches up without downtime.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider, WrappedDek } from '@salvations/core';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKeyError';
  }
}

function assertKey(key: Uint8Array, version: number): void {
  if (key.length !== KEY_BYTES) {
    throw new InvalidKeyError(
      `KEK v${version} must be exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
}

/**
 * Wraps a DEK under a versioned KEK using AES-256-GCM.
 *
 * Layout: [version:4][iv:12][tag:16][ciphertext]. The version is stored inside
 * the blob as well as on the row, so an unwrap can select the right key even if
 * the row's metadata is ever lost or wrong.
 */
export class InMemoryKeyProvider implements KeyProvider {
  readonly name: string;
  readonly version: number;
  readonly #keys: ReadonlyMap<number, Uint8Array>;

  constructor(name: string, keys: ReadonlyMap<number, Uint8Array>, currentVersion: number) {
    const current = keys.get(currentVersion);
    if (current === undefined) {
      throw new InvalidKeyError(`No KEK for current version ${currentVersion}.`);
    }
    for (const [version, key] of keys) assertKey(key, version);
    this.name = name;
    this.version = currentVersion;
    this.#keys = keys;
  }

  async wrap(dek: Uint8Array): Promise<WrappedDek> {
    const kek = this.#keys.get(this.version);
    if (kek === undefined) throw new InvalidKeyError(`No KEK for version ${this.version}.`);

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, kek, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();

    const header = Buffer.alloc(4);
    header.writeUInt32BE(this.version, 0);

    return {
      wrapped: new Uint8Array(Buffer.concat([header, iv, tag, ciphertext])),
      keyProvider: this.name,
      kekVersion: this.version,
    };
  }

  async unwrap(wrapped: WrappedDek): Promise<Uint8Array> {
    const buf = Buffer.from(wrapped.wrapped);
    if (buf.length < 4 + IV_BYTES + TAG_BYTES) {
      throw new InvalidKeyError('Wrapped DEK is truncated.');
    }
    // Trust the embedded version over the row's metadata: the blob is
    // authenticated, the metadata is not.
    const version = buf.readUInt32BE(0);
    const kek = this.#keys.get(version);
    if (kek === undefined) {
      throw new InvalidKeyError(
        `No KEK for version ${version}. A retired key was removed before every row ` +
          'referencing it was re-wrapped; restore it and finish the rotation.',
      );
    }

    const iv = buf.subarray(4, 4 + IV_BYTES);
    const tag = buf.subarray(4 + IV_BYTES, 4 + IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(4 + IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, kek, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
}

const decodeKey = (encoded: string): Uint8Array => new Uint8Array(Buffer.from(encoded, 'base64'));

/**
 * Reads KEKs from the environment.
 *
 * CREDENTIAL_KEK is the current key; CREDENTIAL_KEK_V<n> supplies retired
 * versions during a rotation. Used on hosts where env vars are the encrypted
 * secret store.
 */
export function envKeyProvider(
  env: NodeJS.ProcessEnv = process.env,
  currentVersion = Number(env['CREDENTIAL_KEK_VERSION'] ?? 1),
): KeyProvider {
  const current = env['CREDENTIAL_KEK'];
  if (current === undefined || current === '') {
    throw new InvalidKeyError(
      'CREDENTIAL_KEK is not set. Generate one with: openssl rand -base64 32',
    );
  }
  const keys = new Map<number, Uint8Array>([[currentVersion, decodeKey(current)]]);
  for (const [name, value] of Object.entries(env)) {
    const match = /^CREDENTIAL_KEK_V(\d+)$/.exec(name);
    if (match !== null && value !== undefined && value !== '') {
      keys.set(Number(match[1]), decodeKey(value));
    }
  }
  return new InMemoryKeyProvider('env', keys, currentVersion);
}

/** Development-only convenience. Never use a generated key in production. */
export function ephemeralKeyProvider(version = 1): KeyProvider {
  return new InMemoryKeyProvider(
    'ephemeral',
    new Map([[version, new Uint8Array(randomBytes(KEY_BYTES))]]),
    version,
  );
}

export const generateKek = (): string => randomBytes(KEY_BYTES).toString('base64');
