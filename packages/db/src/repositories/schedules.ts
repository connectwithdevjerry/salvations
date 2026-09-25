/**
 * Recurring instructions.
 *
 * The one subtle method is `claimOccurrence`. A tick may run twice — two
 * instances, a retry, an overlapping cron — and both would see the same
 * occurrence as due. So claiming is a conditional update: the occurrence is
 * written only if the stored one is still older, and whichever write lands
 * second matches nothing. Reading, comparing and then writing would let both
 * through and fire the schedule twice.
 */
import type { Db } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import type { ScheduleDoc } from '../documents';
import { PlatformDb, ScopedDb, type ScopedCollection } from '../scoped';

/** Stop trying after this many consecutive failures to start a run. */
export const FAILURE_LIMIT = 10;

export class ScheduleRepository {
  readonly #collection: ScopedCollection<ScheduleDoc>;

  constructor(db: Db, workspaceId: string) {
    this.#collection = new ScopedDb(db, workspaceId).collection<ScheduleDoc>('schedules');
  }

  async list(): Promise<ScheduleDoc[]> {
    return this.#collection.find({}, { sort: { createdAt: -1 } });
  }

  async findById(id: string): Promise<ScheduleDoc | null> {
    return this.#collection.findOne({ _id: id } as never);
  }

  async create(input: {
    name: string;
    expression: string;
    timeZone: string;
    agentId: string;
    modelBindingId: string;
    prompt: string;
    createdBy: string;
  }): Promise<ScheduleDoc> {
    const now = new Date();
    return this.#collection.insertOne({
      _id: newId(IdPrefix.schedule),
      ...input,
      enabled: true,
      /*
       * Starts at creation time, not null.
       *
       * Null would mean "nothing has fired yet", and the catch-up walk would
       * read that as every occurrence since the epoch being owed. A schedule
       * created at noon should next fire at its next occurrence, not
       * immediately for this morning's.
       */
      lastFiredFor: now,
      lastRunId: null,
      consecutiveFailures: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    } as never);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.#collection.updateOne(
      { _id: id } as never,
      // Re-enabling clears the failure count, otherwise a schedule disabled for
      // hitting the limit is re-disabled by its very next failure.
      { $set: { enabled, consecutiveFailures: 0, lastError: null, updatedAt: new Date() } } as never,
    );
  }

  async remove(id: string): Promise<void> {
    await this.#collection.deleteOne({ _id: id } as never);
  }

  /**
   * Takes ownership of one occurrence.
   *
   * True means this caller should fire it. False means somebody else already
   * did — not an error, and not something to retry.
   */
  async claimOccurrence(id: string, occurrence: Date): Promise<boolean> {
    const result = await this.#collection.updateOne(
      // `$lt` is what makes it exclusive: a second writer finds `lastFiredFor`
      // already at or past this occurrence and matches nothing.
      { _id: id, lastFiredFor: { $lt: occurrence } } as never,
      { $set: { lastFiredFor: occurrence, updatedAt: new Date() } } as never,
    );
    return result.modifiedCount === 1;
  }

  async recordRun(id: string, runId: string): Promise<void> {
    await this.#collection.updateOne(
      { _id: id } as never,
      { $set: { lastRunId: runId, consecutiveFailures: 0, lastError: null } } as never,
    );
  }

  /**
   * Records a failure to START a run, and gives up after enough of them.
   *
   * A schedule pointed at a deleted agent cannot succeed by being retried, and
   * one that keeps trying every minute for ever is noise that buries whatever
   * else is wrong.
   */
  async recordFailure(id: string, message: string): Promise<void> {
    const current = await this.findById(id);
    const failures = (current?.consecutiveFailures ?? 0) + 1;

    await this.#collection.updateOne(
      { _id: id } as never,
      {
        $set: {
          consecutiveFailures: failures,
          lastError: message.slice(0, 500),
          ...(failures >= FAILURE_LIMIT ? { enabled: false } : {}),
          updatedAt: new Date(),
        },
      } as never,
    );
  }
}

/**
 * Every enabled schedule, across every workspace.
 *
 * Unscoped by necessity and by declaration: the tick is a platform operation
 * that has no workspace until it has read a row. Each schedule carries its own
 * workspaceId, and everything done with one afterwards is scoped to it.
 */
export async function enabledSchedules(db: Db, limit = 500): Promise<ScheduleDoc[]> {
  return new PlatformDb(db, 'schedule-tick')
    .collection<ScheduleDoc>('schedules')
    .find({ enabled: true }, { limit })
    .toArray() as Promise<ScheduleDoc[]>;
}
