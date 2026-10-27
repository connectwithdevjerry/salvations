/**
 * Counting what the landing page's voice demo spends.
 *
 * One row per counter and window, incremented atomically, and reaped by a TTL
 * index once its window has passed. The increment comes first and the check
 * after, so two requests racing for the last slot cannot both get it.
 */
import type { Db } from 'mongodb';
import { PlatformDb } from '../scoped';

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
