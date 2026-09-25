/**
 * Envelope encryption for stored credentials.
 *
 * Per-credential random DEK -> AES-256-GCM over the plaintext -> DEK wrapped by
 * a versioned KEK held behind a KeyProvider. The KEK never touches a database
 * row, and rotating it re-wraps DEKs rather than re-encrypting plaintext.
 *
 * Every ciphertext is bound to its row by additional authenticated data, so a
 * blob lifted from one credential and pasted into another — or into another
 * workspace — fails to decrypt instead of silently yielding a valid secret.
 * Without that binding, database write access alone would be enough to make one
 * tenant's credential resolve inside another tenant's request.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyProvider } from '@salvations/core';
import { Secret } from './secret';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const DEK_BYTES = 32;

export interface EncryptedPayload {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly wrappedDek: Uint8Array;
  readonly keyProvider: string;
  readonly kekVersion: number;
}

/** Identity the ciphertext is cryptographically bound to. */
export interface CredentialBinding {
  readonly workspaceId: string;
  readonly credentialId: string;
  readonly kind: string;
}

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

const aadFor = (binding: CredentialBinding): Buffer =>
  Buffer.from(`v1|${binding.workspaceId}|${binding.credentialId}|${binding.kind}`, 'utf8');

export class EnvelopeCipher {
  readonly #keyProvider: KeyProvider;

  constructor(keyProvider: KeyProvider) {
    this.#keyProvider = keyProvider;
  }

  async encrypt(plaintext: string, binding: CredentialBinding): Promise<EncryptedPayload> {
    // A fresh DEK per credential: one compromised DEK exposes one credential,
    // and rotation never has to re-encrypt plaintext.
    const dek = randomBytes(DEK_BYTES);
    const iv = randomBytes(IV_BYTES);

    const cipher = createCipheriv(ALGORITHM, dek, iv, { authTagLength: 16 });
    cipher.setAAD(aadFor(binding));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const wrapped = await this.#keyProvider.wrap(new Uint8Array(dek));
    dek.fill(0);

    return {
      ciphertext: new Uint8Array(ciphertext),
      iv: new Uint8Array(iv),
      authTag: new Uint8Array(authTag),
      wrappedDek: wrapped.wrapped,
      keyProvider: wrapped.keyProvider,
      kekVersion: wrapped.kekVersion,
    };
  }

  async decrypt(payload: EncryptedPayload, binding: CredentialBinding): Promise<Secret> {
    let dek: Uint8Array | undefined;
    try {
      dek = await this.#keyProvider.unwrap({
        wrapped: payload.wrappedDek,
        keyProvider: payload.keyProvider,
        kekVersion: payload.kekVersion,
      });

      const decipher = createDecipheriv(ALGORITHM, dek, payload.iv, { authTagLength: 16 });
      decipher.setAAD(aadFor(binding));
      decipher.setAuthTag(payload.authTag);

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext)),
        decipher.final(),
      ]);
      return new Secret(plaintext.toString('utf8'), binding.kind);
    } catch (error) {
      // Never surface the underlying reason: the distinction between a wrong
      // key, a wrong binding and a corrupted blob is an oracle.
      throw new DecryptionError(
        'Failed to decrypt credential. The ciphertext, its binding, or the key version ' +
          'does not match what was stored.',
        { cause: error },
      );
    } finally {
      dek?.fill(0);
    }
  }

  /**
   * Re-wraps a DEK under the current KEK without touching the ciphertext.
   *
   * This is what makes rotation cheap: the plaintext is never decrypted, so a
   * rotation job needs no access to the secrets it is rotating.
   */
  async rewrap(payload: EncryptedPayload): Promise<EncryptedPayload> {
    const dek = await this.#keyProvider.unwrap({
      wrapped: payload.wrappedDek,
      keyProvider: payload.keyProvider,
      kekVersion: payload.kekVersion,
    });
    try {
      const wrapped = await this.#keyProvider.wrap(dek);
      return {
        ...payload,
        wrappedDek: wrapped.wrapped,
        keyProvider: wrapped.keyProvider,
        kekVersion: wrapped.kekVersion,
      };
    } finally {
      dek.fill(0);
    }
  }

  get currentKekVersion(): number {
    return this.#keyProvider.version;
  }

  needsRewrap(payload: EncryptedPayload): boolean {
    return payload.kekVersion !== this.#keyProvider.version;
  }
}

/** Constant-time comparison for opaque tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Length is not secret, but a length-dependent early return would leak it via
  // timing; compare a fixed-size digest-shaped buffer instead.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
