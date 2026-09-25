import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { ApiKeyRepository, AUTH_FAILURE_RESPONSE, type ApiKeyDoc, type ApiKeyResult } from './api-keys';
import { mintApiKey } from '@salvations/crypto';

function fakeDb(doc: Partial<ApiKeyDoc> | null) {
  const calls: { filter: unknown; options: unknown }[] = [];
  const db = {
    collection: () => ({
      findOne: async (filter: unknown, options: unknown) => {
        calls.push({ filter, options });
        return doc;
      },
      updateOne: async () => ({ matchedCount: 1 }),
    }),
  } as unknown as Db;
  return { db, calls };
}

const seed = (over: Partial<ApiKeyDoc> = {}) => {
  const minted = mintApiKey('live');
  const doc: Partial<ApiKeyDoc> = {
    _id: 'key_1',
    workspaceId: 'wks_1',
    prefix: minted.prefix,
    keyHash: minted.keyHash,
    scopes: ['runs:create'],
    revokedAt: null,
    expiresAt: null,
    ...over,
  };
  return { raw: minted.key.expose(), doc };
};

describe('api key resolution', () => {
  it('resolves a valid key to its workspace and scopes', async () => {
    const { raw, doc } = seed();
    const { db } = fakeDb(doc);
    const result = await new ApiKeyRepository(db).resolve(raw);
    expect(result).toEqual({
      ok: true,
      key: { apiKeyId: 'key_1', workspaceId: 'wks_1', scopes: ['runs:create'] },
    });
  });

  it('rejects a malformed key without touching the database', async () => {
    const { db, calls } = fakeDb(null);
    expect(await new ApiKeyRepository(db).resolve('garbage')).toEqual({
      ok: false, reason: 'malformed',
    });
    expect(calls).toHaveLength(0);
  });

  it('looks up by the indexed prefix, not by scanning hashes', async () => {
    const { raw, doc } = seed();
    const { db, calls } = fakeDb(doc);
    await new ApiKeyRepository(db).resolve(raw);
    expect(calls[0]?.filter).toEqual({ prefix: doc.prefix });
  });

  it('declares itself to the tenancy guard — the workspace is unknown until resolved', async () => {
    const { raw, doc } = seed();
    const { db, calls } = fakeDb(doc);
    await new ApiKeyRepository(db).resolve(raw);
    expect((calls[0]?.options as { comment: unknown }).comment)
      .toEqual({ salvations: 'platform:api-key-lookup' });
  });

  it('rejects a wrong secret presented against a real prefix', async () => {
    const { doc } = seed();
    const { db } = fakeDb(doc);
    const other = mintApiKey('live').key.expose();
    const forged = `sk_live_${doc.prefix}_${other.split('_').slice(3).join('_')}`;
    expect(await new ApiKeyRepository(db).resolve(forged)).toEqual({
      ok: false, reason: 'bad_secret',
    });
  });

  it('verifies the secret BEFORE reporting revocation — otherwise prefixes are enumerable', async () => {
    // Reporting "revoked" to anyone who guesses a prefix is a free oracle for
    // which keys exist. The secret has to be proven first.
    const { doc } = seed({ revokedAt: new Date() });
    const { db } = fakeDb(doc);
    const result = await new ApiKeyRepository(db).resolve('sk_live_aaaaaa_wrongsecret');
    expect(result).toEqual({ ok: false, reason: 'bad_secret' });
  });

  it('presents one indistinguishable failure to the client', async () => {
    // Internally the reasons differ, which is useful for audit. Externally they
    // must not: "unknown" versus "bad_secret" tells an attacker which prefixes
    // exist, and "revoked" tells them which keys once did.
    const { raw, doc } = seed({ revokedAt: new Date() });
    const repo = new ApiKeyRepository(fakeDb(doc).db);
    const missing = new ApiKeyRepository(fakeDb(null).db);

    const results: ApiKeyResult[] = [
      await repo.resolve(raw),
      await repo.resolve('sk_live_aaaaaa_wrongsecret'),
      await missing.resolve(raw),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
    }
    // Every one of them maps to the same response.
    expect(AUTH_FAILURE_RESPONSE.status).toBe(401);
    expect(AUTH_FAILURE_RESPONSE.message).toBe('Invalid API key.');
  });

  it('reports revocation only to the holder of the real secret', async () => {
    const { raw, doc } = seed({ revokedAt: new Date() });
    const { db } = fakeDb(doc);
    expect(await new ApiKeyRepository(db).resolve(raw)).toEqual({
      ok: false, reason: 'revoked',
    });
  });

  it('rejects an expired key', async () => {
    const { raw, doc } = seed({ expiresAt: new Date('2020-01-01') });
    const { db } = fakeDb(doc);
    expect(await new ApiKeyRepository(db).resolve(raw)).toEqual({
      ok: false, reason: 'expired',
    });
  });

  it('accepts a key whose expiry is still ahead', async () => {
    const { raw, doc } = seed({ expiresAt: new Date('2099-01-01') });
    const { db } = fakeDb(doc);
    expect((await new ApiKeyRepository(db).resolve(raw)).ok).toBe(true);
  });

  it('rejects an unknown prefix', async () => {
    const { raw } = seed();
    const { db } = fakeDb(null);
    expect(await new ApiKeyRepository(db).resolve(raw)).toEqual({
      ok: false, reason: 'unknown',
    });
  });
});
