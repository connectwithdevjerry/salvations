import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { LeaseLostError, MongoRunQueue, backoffMs } from './run-queue';
import { analyzeCommand } from './guard';

interface Call { op: string; filter?: unknown; update?: unknown; options?: Record<string, unknown> }

/**
 * Records what reaches the driver. These tests are about the SHAPE of the
 * commands — the lease guard and the platform declaration — which is where the
 * correctness lives; behaviour against a real server is covered by the
 * MONGODB_URI-gated integration suite.
 */
function fakeDb(overrides: { findOneAndUpdate?: unknown; find?: unknown[]; matched?: number } = {}) {
  const calls: Call[] = [];
  const collection = {
    findOneAndUpdate: async (filter: unknown, update: unknown, options: Record<string, unknown>) => {
      calls.push({ op: 'findOneAndUpdate', filter, update, options });
      return overrides.findOneAndUpdate ?? null;
    },
    updateOne: async (filter: unknown, update: unknown, options: Record<string, unknown>) => {
      calls.push({ op: 'updateOne', filter, update, options });
      return { matchedCount: overrides.matched ?? 1 };
    },
    find: (filter: unknown, options: Record<string, unknown>) => {
      calls.push({ op: 'find', filter, options });
      return { toArray: async () => overrides.find ?? [] };
    },
  };
  const db = { collection: () => collection } as unknown as Db;
  return { db, calls };
}

const NOW = new Date('2026-09-15T00:00:00.000Z');
const opts = { now: () => NOW };

describe('claim', () => {
  it('only considers runs that are queued, due, and not actively leased', async () => {
    const { db, calls } = fakeDb();
    await new MongoRunQueue(db, opts).claim('worker-1', 60_000);

    const filter = calls[0]?.filter as Record<string, unknown>;
    expect(filter['status']).toBe('queued');
    expect(filter['scheduledFor']).toEqual({ $lte: NOW });
    // An unleased run, or one whose previous holder let the lease lapse.
    expect(filter['$or']).toEqual([{ lease: { $eq: null } }, { 'lease.until': { $lt: NOW } }]);
  });

  it('takes the highest priority, then the longest waiting', async () => {
    const { db, calls } = fakeDb();
    await new MongoRunQueue(db, opts).claim('worker-1', 60_000);
    expect(calls[0]?.options?.['sort']).toEqual({ priority: -1, scheduledFor: 1 });
    expect(calls[0]?.options?.['returnDocument']).toBe('after');
  });

  it('preserves the original start time when a run is reclaimed', async () => {
    // Wall-clock budget accounting must survive slicing; overwriting startedAt
    // on every claim would silently reset it.
    const { db, calls } = fakeDb();
    await new MongoRunQueue(db, opts).claim('worker-1', 60_000);
    const pipeline = calls[0]?.update as { $set: Record<string, unknown> }[];
    expect(pipeline[0]?.$set['startedAt']).toEqual({ $ifNull: ['$startedAt', NOW] });
    expect(pipeline[0]?.$set['attempts']).toEqual({ $add: [{ $ifNull: ['$attempts', 0] }, 1] });
  });

  it('issues a fresh lease token per claim', async () => {
    const { db, calls } = fakeDb({ findOneAndUpdate: { _id: 'run_1' } });
    const q = new MongoRunQueue(db, opts);
    const a = await q.claim('worker-1', 60_000);
    const b = await q.claim('worker-2', 60_000);
    expect(a?.leaseToken).not.toBe(b?.leaseToken);
    const first = (calls[0]?.update as { $set: { lease: { token: string } } }[])[0]?.$set.lease.token;
    expect(first).toBe(a?.leaseToken);
  });

  it('can be narrowed to a subset of workspaces', async () => {
    const { db, calls } = fakeDb();
    await new MongoRunQueue(db, opts).claim('worker-1', 60_000, ['wks_1', 'wks_2']);
    expect((calls[0]?.filter as Record<string, unknown>)['workspaceId']).toEqual({
      $in: ['wks_1', 'wks_2'],
    });
  });

  it('returns null when nothing is runnable', async () => {
    const { db } = fakeDb();
    expect(await new MongoRunQueue(db, opts).claim('worker-1', 60_000)).toBeNull();
  });
});

describe('lease guard — the property that prevents duplicate side effects', () => {
  it('scopes a heartbeat to the holder of the token', async () => {
    const { db, calls } = fakeDb();
    await new MongoRunQueue(db, opts).heartbeat('run_1', 'lse_abc', 60_000);
    expect(calls[0]?.filter).toEqual({ _id: 'run_1', 'lease.token': 'lse_abc' });
  });

  it('throws when the lease was stolen mid-slice', async () => {
    // The dangerous case: a slow executor is still working when its lease
    // lapses and another claims the run. It must stop, not retry.
    const { db } = fakeDb({ matched: 0 });
    await expect(
      new MongoRunQueue(db, opts).heartbeat('run_1', 'lse_stale', 60_000),
    ).rejects.toThrow(LeaseLostError);
  });

  it('scopes every release variant to the token', async () => {
    const { db, calls } = fakeDb();
    const q = new MongoRunQueue(db, opts);
    await q.release('run_1', 'lse_abc', { kind: 'requeue', scheduledFor: NOW, fromStep: 7 });
    await q.release('run_1', 'lse_abc', { kind: 'suspend', status: 'waiting_approval' });
    await q.release('run_1', 'lse_abc', { kind: 'finish', status: 'succeeded' });
    for (const call of calls) {
      expect(call.filter).toEqual({ _id: 'run_1', 'lease.token': 'lse_abc' });
    }
  });

  it('refuses to release a run whose lease was stolen', async () => {
    const { db } = fakeDb({ matched: 0 });
    await expect(
      new MongoRunQueue(db, opts).release('run_1', 'lse_stale', { kind: 'finish', status: 'succeeded' }),
    ).rejects.toThrow(LeaseLostError);
  });

  it('records the continuation point when yielding a slice', async () => {
    const { db, calls } = fakeDb();
    await new MongoRunQueue(db, opts).release('run_1', 'lse_abc', {
      kind: 'requeue', scheduledFor: NOW, fromStep: 7,
    });
    const update = calls[0]?.update as { $set: Record<string, unknown> };
    expect(update.$set['status']).toBe('queued');
    expect(update.$set['lease']).toBeNull();
    expect(update.$set['continuation']).toEqual({ fromStep: 7, reason: 'deadline' });
  });

  it('drops the lease when suspending, since a wait may last hours', async () => {
    const { db, calls } = fakeDb();
    await new MongoRunQueue(db, opts).release('run_1', 'lse_abc', {
      kind: 'suspend', status: 'waiting_input',
    });
    expect((calls[0]?.update as { $set: Record<string, unknown> }).$set['lease']).toBeNull();
  });
});

describe('sweep', () => {
  it('requeues a stalled run with backoff', async () => {
    const { db, calls } = fakeDb({ find: [{ _id: 'run_1', attempts: 2 }] });
    const result = await new MongoRunQueue(db, opts).sweep();
    expect(result).toEqual({ requeued: 1, failed: 0 });
    const update = calls[1]?.update as { $set: Record<string, unknown> };
    expect(update.$set['status']).toBe('queued');
    expect((update.$set['scheduledFor'] as Date).getTime()).toBeGreaterThanOrEqual(NOW.getTime());
  });

  it('fails a run that has exhausted its attempts instead of retrying forever', async () => {
    const { db, calls } = fakeDb({ find: [{ _id: 'run_1', attempts: 5 }] });
    const result = await new MongoRunQueue(db, { ...opts, maxAttempts: 5 }).sweep();
    expect(result).toEqual({ requeued: 0, failed: 1 });
    const update = calls[1]?.update as { $set: Record<string, unknown> };
    expect(update.$set['status']).toBe('failed');
    expect((update.$set['error'] as { code: string }).code).toBe('lease_exhausted');
  });

  it('re-asserts the stalled precondition so two sweepers cannot double-handle a run', async () => {
    const { db, calls } = fakeDb({ find: [{ _id: 'run_1', attempts: 1 }] });
    await new MongoRunQueue(db, opts).sweep();
    expect(calls[1]?.filter).toEqual({
      _id: 'run_1', status: 'running', 'lease.until': { $lt: NOW },
    });
  });
});

describe('platform declaration', () => {
  it('marks every queue command so the tenancy guard permits it', async () => {
    // The queue spans workspaces by design. It says so explicitly, rather than
    // being allowlisted by collection — the exemption stays greppable.
    const { db, calls } = fakeDb({ find: [] });
    const q = new MongoRunQueue(db, opts);
    await q.claim('w', 1000);
    await q.heartbeat('run_1', 't', 1000);
    await q.release('run_1', 't', { kind: 'finish', status: 'succeeded' });
    await q.sweep();
    await q.findOrphanedQueued(60_000);

    for (const call of calls) {
      expect(call.options?.['comment']).toEqual({ salvations: expect.stringMatching(/^platform:queue-/) });
    }
  });

  it('is actually accepted by the guard it declares itself to', async () => {
    // Ties the declaration to the enforcement: a cross-workspace claim carrying
    // this comment must pass, and the same claim without it must not.
    const { db, calls } = fakeDb();
    await new MongoRunQueue(db, opts).claim('w', 1000);
    const command = {
      findAndModify: 'runs',
      query: calls[0]?.filter,
      comment: calls[0]?.options?.['comment'],
    };
    expect(analyzeCommand('findAndModify', command)).toBeUndefined();

    const { comment: _dropped, ...withoutComment } = command;
    expect(analyzeCommand('findAndModify', withoutComment)?.reason).toBe('missing_workspace_filter');
  });
});

describe('backoffMs', () => {
  it('grows with attempts and stays within the cap', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const v = backoffMs(attempt, 1000, 60_000);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(60_000);
    }
  });

  it('uses full jitter, so reclaimed runs do not stampede', () => {
    const samples = new Set(Array.from({ length: 200 }, () => backoffMs(8, 1000, 60_000)));
    expect(samples.size).toBeGreaterThan(50);
  });
});
