/** The voice demo's counters against a real MongoDB. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { syncIndexes } from '../indexes';
import { DemoUsageRepository } from './demo-usage';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_demo_usage`;

let client: MongoClient | undefined;
let db: Db;

describe.skipIf(URI === undefined || URI === '')('Demo usage against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
  });

  afterAll(async () => { await client?.close(); });

  it('allows a visitor up to the limit in a window and no further', async () => {
    const usage = new DemoUsageRepository(db);
    const now = Date.UTC(2026, 0, 1, 10);
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await usage.take('visitor:a', 3, 3_600_000, now));
    expect(results).toEqual([true, true, true, false]);
    expect(await usage.take('visitor:a', 3, 3_600_000, now + 3_600_000)).toBe(true);
  });
});
