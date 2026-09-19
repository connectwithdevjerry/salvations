/**
 * Credentials against a real MongoDB.
 *
 * The unit tests hand the repository what it wrote; this one hands it what the
 * DRIVER returns, which is a different type for binary fields. A Telegram bot
 * token that stores fine and then fails to resolve is the failure this guards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { ephemeralKeyProvider } from '@salvations/crypto';
import { syncIndexes } from '../indexes';
import { CredentialRepository } from './credentials';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_credentials`;
const WS = 'wks_credentials';

let client: MongoClient | undefined;
let db: Db;

describe.skipIf(URI === undefined || URI === '')('Credentials against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
  });

  afterAll(async () => { await client?.close(); });

  it('resolves what it stored after a round trip through the driver', async () => {
    const keys = ephemeralKeyProvider();
    const repo = new CredentialRepository(db, WS, keys);
    const stored = await repo.store({
      name: 'bot', kind: 'telegram_bot_token', plaintext: '123456:secret-token', createdBy: 'usr_1',
    });

    // A fresh repository so nothing is served from anything but the row.
    const secret = await new CredentialRepository(db, WS, keys).resolve(stored._id);
    expect(secret?.expose()).toBe('123456:secret-token');
  });

  it('stores binary fields as binData, never as text', async () => {
    const repo = new CredentialRepository(db, WS, ephemeralKeyProvider());
    const stored = await repo.store({ name: 'k', kind: 'api_key', plaintext: 'sk-live', createdBy: 'usr_1' });
    const raw = await db.collection('credentials').findOne({ _id: stored._id as never });
    for (const field of ['ciphertext', 'iv', 'authTag', 'wrappedDek']) {
      expect(typeof raw?.[field], field).not.toBe('string');
    }
    expect(JSON.stringify(raw)).not.toContain('sk-live');
  });

  it('cannot resolve a credential from another workspace', async () => {
    const keys = ephemeralKeyProvider();
    const stored = await new CredentialRepository(db, WS, keys)
      .store({ name: 'k', kind: 'api_key', plaintext: 'sk-mine', createdBy: 'usr_1' });
    expect(await new CredentialRepository(db, 'wks_other', keys).resolve(stored._id)).toBeNull();
  });
});
