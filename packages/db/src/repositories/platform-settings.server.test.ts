/**
 * The site's own settings against a real MongoDB: the key the voice demo runs
 * on, and the counters that stop strangers spending it without limit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { ephemeralKeyProvider } from '@salvations/crypto';
import { syncIndexes } from '../indexes';
import { DemoUsageRepository, PlatformSettingsRepository } from './platform-settings';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_platform`;

let client: MongoClient | undefined;
let db: Db;

describe.skipIf(URI === undefined || URI === '')('Platform settings against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
  });

  afterAll(async () => { await client?.close(); });

  it('keeps the key encrypted, shows only its last four, and resolves it back', async () => {
    const keys = ephemeralKeyProvider();
    const summary = await new PlatformSettingsRepository(db, keys).setSecret('openai', 'sk-test-abcdefghijkl1234', 'ops@example.com');
    expect(summary.hint).toBe('1234');

    const row = await db.collection('platformSettings').findOne({ _id: 'secret:openai' as never });
    expect(JSON.stringify(row)).not.toContain('sk-test');

    const fresh = new PlatformSettingsRepository(db, keys);
    expect((await fresh.describeSecret('openai'))?.updatedBy).toBe('ops@example.com');
    expect((await fresh.resolveSecret('openai'))?.expose()).toBe('sk-test-abcdefghijkl1234');

    await fresh.clearSecret('openai');
    expect(await fresh.resolveSecret('openai')).toBeNull();
  });

  it('allows a visitor up to the limit in a window and no further', async () => {
    const usage = new DemoUsageRepository(db);
    const now = Date.UTC(2026, 0, 1, 10);
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await usage.take('visitor:a', 3, 3_600_000, now));
    expect(results).toEqual([true, true, true, false]);
    // A new window starts the count again.
    expect(await usage.take('visitor:a', 3, 3_600_000, now + 3_600_000)).toBe(true);
  });
});
