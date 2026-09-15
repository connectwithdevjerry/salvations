/**
 * MongoRunQueue — the `runs` collection IS the work queue.
 *
 * This removes an entire component: no Redis, no outbox, no separate queue
 * store in Phase 1. When Redis arrives in Phase 4 it becomes a NOTIFICATION
 * layer while this collection stays the source of truth, so a lost message
 * costs latency (the sweeper still finds the run) and never correctness.
 *
 * Two properties carry the weight, and both are tested by AC-9:
 *
 *   1. Claiming is a single atomic findOneAndUpdate. Two executors racing for
 *      the same run cannot both win.
 *   2. EVERY subsequent write is guarded by the lease token. An executor whose
 *      lease expired and was stolen cannot write — which is what actually
 *      prevents duplicate tool side effects. Atomic claiming alone does not:
 *      a slow executor may still be mid-step when its lease lapses.
 */
import type { Collection, Db } from 'mongodb';
import type { RunDoc } from './documents.js';
import { PlatformDb, type PlatformReason } from './scoped.js';

export type RunStatusLike =
  | 'queued' | 'running' | 'waiting_approval' | 'waiting_input' | 'waiting_tool'
  | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface ClaimedRunDoc {
  readonly run: RunDoc;
  readonly leaseToken: string;
  readonly leaseUntil: Date;
}

export type ReleaseIntentDoc =
  | { readonly kind: 'requeue'; readonly scheduledFor: Date; readonly fromStep?: number }
  | { readonly kind: 'suspend'; readonly status: 'waiting_approval' | 'waiting_input' | 'waiting_tool' }
  | {
      readonly kind: 'finish';
      readonly status: 'succeeded' | 'failed' | 'cancelled' | 'expired';
      readonly error?: { code: string; message: string };
    };

export class LeaseLostError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(
      `Lease lost for run ${runId}. Another executor claimed it, so this one must ` +
        'stop writing immediately — continuing would duplicate side effects.',
    );
    this.name = 'LeaseLostError';
    this.runId = runId;
  }
}

/** Exponential backoff with full jitter, so reclaimed runs do not stampede. */
export function backoffMs(attempts: number, baseMs = 1_000, capMs = 60_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.floor(Math.random() * ceiling);
}

export interface RunQueueOptions {
  /** Attempts beyond which a run is failed rather than reclaimed again. */
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}

export class MongoRunQueue {
  readonly #db: Db;
  readonly #maxAttempts: number;
  readonly #now: () => Date;

  constructor(db: Db, options: RunQueueOptions = {}) {
    this.#db = db;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#now = options.now ?? (() => new Date());
  }

  /** Every command from this queue declares itself to the tenancy guard. */
  #runs(reason: PlatformReason): { collection: Collection<RunDoc>; comment: { salvations: string } } {
    const platform = new PlatformDb(this.#db, reason);
    return { collection: platform.collection<RunDoc>('runs'), comment: platform.comment };
  }

  /**
   * Claim one runnable run.
   *
   * The filter deliberately spans workspaces: scheduling is a platform concern
   * and must see across tenants to be fair. `workspaceIds` narrows it when a
   * worker is dedicated to a subset.
   */
  async claim(
    owner: string,
    leaseMs: number,
    workspaceIds?: readonly string[],
  ): Promise<ClaimedRunDoc | null> {
    const { collection, comment } = this.#runs('queue-claim');
    const now = this.#now();
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const token = `lse_${crypto.randomUUID()}`;

    const doc = await collection.findOneAndUpdate(
      {
        status: 'queued',
        scheduledFor: { $lte: now },
        // Either never leased, or the previous holder's lease has lapsed.
        $or: [{ lease: { $eq: null } }, { 'lease.until': { $lt: now } }],
        ...(workspaceIds !== undefined ? { workspaceId: { $in: [...workspaceIds] } } : {}),
      },
      [
        {
          $set: {
            status: 'running',
            // First start only — a reclaimed run keeps its original start time,
            // so wall-clock budget accounting stays honest across slices.
            startedAt: { $ifNull: ['$startedAt', now] },
            heartbeatAt: now,
            lease: { owner, until: leaseUntil, token },
            attempts: { $add: [{ $ifNull: ['$attempts', 0] }, 1] },
          },
        },
      ],
      {
        sort: { priority: -1, scheduledFor: 1 },
        returnDocument: 'after',
        comment,
      },
    );

    if (doc === null) return null;
    return { run: doc, leaseToken: token, leaseUntil };
  }

  /**
   * Extend the lease. Throws if the lease was stolen — the caller MUST stop
   * writing rather than treat this as a transient failure.
   */
  async heartbeat(runId: string, token: string, leaseMs: number): Promise<Date> {
    const { collection, comment } = this.#runs('queue-claim');
    const now = this.#now();
    const until = new Date(now.getTime() + leaseMs);
    const result = await collection.updateOne(
      { _id: runId, 'lease.token': token },
      { $set: { 'lease.until': until, heartbeatAt: now } },
      { comment },
    );
    if (result.matchedCount === 0) throw new LeaseLostError(runId);
    return until;
  }

  /** Hand the run back. Guarded by the lease token, like every other write. */
  async release(runId: string, token: string, intent: ReleaseIntentDoc): Promise<void> {
    const { collection, comment } = this.#runs('queue-claim');
    const now = this.#now();

    const update = (() => {
      switch (intent.kind) {
        case 'requeue':
          return {
            $set: {
              status: 'queued' as const,
              scheduledFor: intent.scheduledFor,
              lease: null,
              ...(intent.fromStep !== undefined
                ? { continuation: { fromStep: intent.fromStep, reason: 'deadline' } }
                : {}),
            },
          };
        case 'suspend':
          // A suspended run holds no process and no lease: it waits on a human
          // or an external task, which may take hours.
          return { $set: { status: intent.status, lease: null, heartbeatAt: now } };
        case 'finish':
          return {
            $set: {
              status: intent.status,
              lease: null,
              finishedAt: now,
              ...(intent.error !== undefined ? { error: intent.error } : {}),
            },
          };
      }
    })();

    const result = await collection.updateOne({ _id: runId, 'lease.token': token }, update, { comment });
    if (result.matchedCount === 0) throw new LeaseLostError(runId);
  }

  /**
   * Reclaim runs whose lease lapsed — the safety net behind the push path.
   *
   * A run that has burned through its attempts is failed rather than reclaimed
   * forever: an infinite retry loop is worse than a clean failure with a
   * partial result.
   */
  async sweep(limit = 50): Promise<{ requeued: number; failed: number }> {
    const { collection, comment } = this.#runs('queue-sweep');
    const now = this.#now();

    const stalled = await collection
      .find(
        { status: 'running', 'lease.until': { $lt: now } },
        { sort: { 'lease.until': 1 }, limit, comment },
      )
      .toArray();

    let requeued = 0;
    let failed = 0;

    for (const run of stalled) {
      const exhausted = (run.attempts ?? 0) >= this.#maxAttempts;
      const update = exhausted
        ? {
            $set: {
              status: 'failed' as const,
              lease: null,
              finishedAt: now,
              error: {
                code: 'lease_exhausted',
                message:
                  `Run reclaimed ${run.attempts} times without completing. ` +
                  'Failing with a partial result rather than retrying indefinitely.',
              },
            },
          }
        : {
            $set: {
              status: 'queued' as const,
              lease: null,
              scheduledFor: new Date(now.getTime() + backoffMs(run.attempts ?? 1)),
            },
          };

      // Re-assert the stalled precondition so a run reclaimed by a concurrent
      // sweeper between the find and the update is not double-handled.
      const result = await collection.updateOne(
        { _id: run._id, status: 'running', 'lease.until': { $lt: now } },
        update,
        { comment },
      );
      if (result.matchedCount === 1) {
        if (exhausted) failed += 1;
        else requeued += 1;
      }
    }

    return { requeued, failed };
  }

  /** Runs that are `queued` and overdue — the push path missed them. */
  async findOrphanedQueued(olderThanMs: number, limit = 50): Promise<string[]> {
    const { collection, comment } = this.#runs('queue-sweep');
    const cutoff = new Date(this.#now().getTime() - olderThanMs);
    const docs = await collection
      .find(
        { status: 'queued', scheduledFor: { $lte: cutoff } },
        { projection: { _id: 1 }, sort: { scheduledFor: 1 }, limit, comment },
      )
      .toArray();
    return docs.map((d) => d._id);
  }
}
