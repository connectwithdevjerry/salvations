import { describe, expect, it } from 'vitest';
import { EnvelopeCipher, DecryptionError, safeEqual, type CredentialBinding } from './envelope';
import { InMemoryKeyProvider, ephemeralKeyProvider, generateKek, envKeyProvider, InvalidKeyError } from './key-provider';
import { Secret } from './secret';

const binding: CredentialBinding = {
  workspaceId: 'wks_a', credentialId: 'crd_1', kind: 'api_key',
};

const keyOf = (seed: number) => new Uint8Array(32).fill(seed);

describe('envelope encryption', () => {
  it('round-trips a secret', async () => {
    const cipher = new EnvelopeCipher(ephemeralKeyProvider());
    const payload = await cipher.encrypt('sk-super-secret', binding);
    const out = await cipher.decrypt(payload, binding);
    expect(out).toBeInstanceOf(Secret);
    expect(out.expose()).toBe('sk-super-secret');
  });

  it('never stores the plaintext in the payload', async () => {
    const cipher = new EnvelopeCipher(ephemeralKeyProvider());
    const payload = await cipher.encrypt('sk-super-secret', binding);
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('sk-super-secret');
    expect(Buffer.from(payload.ciphertext).toString('utf8')).not.toContain('super');
  });

  it('produces a different ciphertext every time', async () => {
    // Fresh DEK and IV per call: identical plaintexts must not be linkable.
    const cipher = new EnvelopeCipher(ephemeralKeyProvider());
    const a = await cipher.encrypt('same', binding);
    const b = await cipher.encrypt('same', binding);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
    expect(Buffer.from(a.wrappedDek).equals(Buffer.from(b.wrappedDek))).toBe(false);
  });
});

describe('binding — a ciphertext cannot be moved', () => {
  it('refuses a ciphertext replayed into another workspace', async () => {
    // The attack this prevents: database write access alone would otherwise let
    // one tenant's credential resolve inside another tenant's request.
    const cipher = new EnvelopeCipher(ephemeralKeyProvider());
    const payload = await cipher.encrypt('sk-secret', binding);
    await expect(
      cipher.decrypt(payload, { ...binding, workspaceId: 'wks_ATTACKER' }),
    ).rejects.toThrow(DecryptionError);
  });

  it('refuses a ciphertext moved to another credential row', async () => {
    const cipher = new EnvelopeCipher(ephemeralKeyProvider());
    const payload = await cipher.encrypt('sk-secret', binding);
    await expect(
      cipher.decrypt(payload, { ...binding, credentialId: 'crd_other' }),
    ).rejects.toThrow(DecryptionError);
  });

  it('refuses a ciphertext relabelled as a different credential kind', async () => {
    const cipher = new EnvelopeCipher(ephemeralKeyProvider());
    const payload = await cipher.encrypt('sk-secret', binding);
    await expect(cipher.decrypt(payload, { ...binding, kind: 'oauth2_token' }))
      .rejects.toThrow(DecryptionError);
  });

  it('refuses a tampered ciphertext', async () => {
    const cipher = new EnvelopeCipher(ephemeralKeyProvider());
    const payload = await cipher.encrypt('sk-secret', binding);
    const tampered = new Uint8Array(payload.ciphertext);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    await expect(cipher.decrypt({ ...payload, ciphertext: tampered }, binding))
      .rejects.toThrow(DecryptionError);
  });

  it('does not reveal WHY decryption failed', async () => {
    // The difference between a wrong key, a wrong binding and a corrupt blob is
    // an oracle; every failure has to look the same from outside.
    const cipher = new EnvelopeCipher(ephemeralKeyProvider());
    const payload = await cipher.encrypt('sk-secret', binding);
    const wrongWorkspace = await cipher.decrypt(payload, { ...binding, workspaceId: 'x' })
      .catch((e: Error) => e.message);
    const tampered = new Uint8Array(payload.ciphertext);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    const corrupt = await cipher.decrypt({ ...payload, ciphertext: tampered }, binding)
      .catch((e: Error) => e.message);
    expect(wrongWorkspace).toBe(corrupt);
  });
});

describe('key rotation', () => {
  const twoKeys = new Map([[1, keyOf(1)], [2, keyOf(2)]]);

  it('decrypts a payload wrapped under a retired key', async () => {
    const v1 = new EnvelopeCipher(new InMemoryKeyProvider('test', twoKeys, 1));
    const payload = await v1.encrypt('sk-secret', binding);

    const v2 = new EnvelopeCipher(new InMemoryKeyProvider('test', twoKeys, 2));
    expect((await v2.decrypt(payload, binding)).expose()).toBe('sk-secret');
  });

  it('flags a payload that still needs re-wrapping', async () => {
    const v1 = new EnvelopeCipher(new InMemoryKeyProvider('test', twoKeys, 1));
    const payload = await v1.encrypt('sk-secret', binding);
    const v2 = new EnvelopeCipher(new InMemoryKeyProvider('test', twoKeys, 2));
    expect(v2.needsRewrap(payload)).toBe(true);
  });

  it('re-wraps without decrypting the plaintext', async () => {
    // Rotation must not require access to the secrets it rotates.
    const v1 = new EnvelopeCipher(new InMemoryKeyProvider('test', twoKeys, 1));
    const payload = await v1.encrypt('sk-secret', binding);

    const v2 = new EnvelopeCipher(new InMemoryKeyProvider('test', twoKeys, 2));
    const rewrapped = await v2.rewrap(payload);

    expect(rewrapped.kekVersion).toBe(2);
    expect(v2.needsRewrap(rewrapped)).toBe(false);
    // The ciphertext is untouched; only the wrapped DEK changed.
    expect(Buffer.from(rewrapped.ciphertext).equals(Buffer.from(payload.ciphertext))).toBe(true);
    expect((await v2.decrypt(rewrapped, binding)).expose()).toBe('sk-secret');
  });

  it('fails loudly when a retired key was dropped too early', async () => {
    const v1 = new EnvelopeCipher(new InMemoryKeyProvider('test', twoKeys, 1));
    const payload = await v1.encrypt('sk-secret', binding);

    const onlyV2 = new EnvelopeCipher(new InMemoryKeyProvider('test', new Map([[2, keyOf(2)]]), 2));
    await expect(onlyV2.decrypt(payload, binding)).rejects.toThrow(DecryptionError);
  });

  it('selects the key from the blob, not from the row metadata', async () => {
    // The blob is authenticated; the row's kekVersion column is not.
    const v1 = new EnvelopeCipher(new InMemoryKeyProvider('test', twoKeys, 1));
    const payload = await v1.encrypt('sk-secret', binding);
    const v2 = new EnvelopeCipher(new InMemoryKeyProvider('test', twoKeys, 2));
    const lying = { ...payload, kekVersion: 2 };
    expect((await v2.decrypt(lying, binding)).expose()).toBe('sk-secret');
  });
});

describe('key providers', () => {
  it('rejects a KEK of the wrong size with actionable guidance', () => {
    expect(() => new InMemoryKeyProvider('bad', new Map([[1, new Uint8Array(16)]]), 1))
      .toThrow(/32 bytes/);
  });

  it('generates a usable KEK', () => {
    expect(Buffer.from(generateKek(), 'base64')).toHaveLength(32);
  });

  it('reads the current key and retired versions from the environment', async () => {
    const provider = envKeyProvider({
      CREDENTIAL_KEK: Buffer.from(keyOf(9)).toString('base64'),
      CREDENTIAL_KEK_VERSION: '3',
      CREDENTIAL_KEK_V1: Buffer.from(keyOf(1)).toString('base64'),
    } as NodeJS.ProcessEnv);
    expect(provider.version).toBe(3);

    const v1 = new EnvelopeCipher(new InMemoryKeyProvider('env', new Map([[1, keyOf(1)]]), 1));
    const old = await v1.encrypt('legacy', binding);
    expect((await new EnvelopeCipher(provider).decrypt(old, binding)).expose()).toBe('legacy');
  });

  it('refuses to start without a KEK', () => {
    expect(() => envKeyProvider({} as NodeJS.ProcessEnv)).toThrow(InvalidKeyError);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal values correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
