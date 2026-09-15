import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { ConversationRepository } from './conversations';
import { RunRepository } from './runs';
import { CredentialRepository } from './credentials';
import { UsageRepository, AuditRepository } from './telemetry';
import { ephemeralKeyProvider, EphemeralSecret } from '@salvations/crypto';
import { DEFAULT_BUDGET } from '@salvations/core';

interface Call { op: string; filter?: unknown; update?: unknown; options?: unknown; doc?: unknown }

/**
 * Records what reaches the driver. These tests are about update SHAPE —
 * whether a write is atomic, guarded, or idempotent — which is where the
 * correctness lives under concurrency.
 */
function recorder(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const collection = (name: string) => ({
    findOne: async (filter: unknown) => {
      calls.push({ op: `${name}.findOne`, filter });
      return (responses[`${name}.findOne`] as unknown) ?? null;
    },
    find: (filter: unknown, options: unknown) => {
      calls.push({ op: `${name}.find`, filter, options });
      return { toArray: async () => (responses[`${name}.find`] as unknown[]) ?? [] };
    },
    insertOne: async (doc: unknown) => {
      calls.push({ op: `${name}.insertOne`, doc });
      return {};
    },
    updateOne: async (filter: unknown, update: unknown, options: unknown) => {
      calls.push({ op: `${name}.updateOne`, filter, update, options });
      return { matchedCount: (responses[`${name}.matched`] as number) ?? 1 };
    },
    findOneAndUpdate: async (filter: unknown, update: unknown, options: unknown) => {
      calls.push({ op: `${name}.findOneAndUpdate`, filter, update, options });
      return (responses[`${name}.findOneAndUpdate`] as unknown) ?? null;
    },
    countDocuments: async () => 0,
  });
  const db = { collection: (name: string) => collection(name) } as unknown as Db;
  return { db, calls, of: (op: string) => calls.filter((c) => c.op === op) };
}

const WS = 'wks_1';

describe('conversation sequence allocation', () => {
  it('reserves a sequence with an atomic $inc, not read-modify-write', async () => {
    // A read-then-write hands the same number to two concurrent appenders and
    // one of their messages loses the unique (conversationId, seq) index.
    const { db, of } = recorder({ 'conversations.findOneAndUpdate': { nextSeq: 7 } });
    await new ConversationRepository(db, WS).appendMessage({
      conversationId: 'cnv_1', role: 'user', content: [{ type: 'text', text: 'hi' }],
    });

    const allocate = of('conversations.findOneAndUpdate')[0];
    expect(allocate?.update).toEqual({ $inc: { nextSeq: 1 } });
    expect((allocate?.options as { returnDocument: string }).returnDocument).toBe('before');
  });

  it('writes the message at the reserved sequence', async () => {
    const { db, of } = recorder({ 'conversations.findOneAndUpdate': { nextSeq: 7 } });
    await new ConversationRepository(db, WS).appendMessage({
      conversationId: 'cnv_1', role: 'user', content: [],
    });
    expect((of('messages.insertOne')[0]?.doc as { seq: number }).seq).toBe(7);
  });

  it('derives a deterministic id from a client message id, so a retry collides', async () => {
    const make = async () => {
      const { db, of } = recorder({ 'conversations.findOneAndUpdate': { nextSeq: 1 } });
      await new ConversationRepository(db, WS).appendMessage({
        conversationId: 'cnv_1', role: 'user', content: [], clientMessageId: 'client-abc',
      });
      return (of('messages.insertOne')[0]?.doc as { _id: string })._id;
    };
    expect(await make()).toBe(await make());
  });

  it('gives distinct ids to messages without a client id', async () => {
    const make = async () => {
      const { db, of } = recorder({ 'conversations.findOneAndUpdate': { nextSeq: 1 } });
      await new ConversationRepository(db, WS).appendMessage({
        conversationId: 'cnv_1', role: 'user', content: [],
      });
      return (of('messages.insertOne')[0]?.doc as { _id: string })._id;
    };
    expect(await make()).not.toBe(await make());
  });

  it('refuses to append to a conversation that does not exist', async () => {
    const { db } = recorder();
    await expect(
      new ConversationRepository(db, WS).appendMessage({
        conversationId: 'cnv_missing', role: 'user', content: [],
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('run creation is idempotent', () => {
  const input = {
    conversationId: 'cnv_1', agentId: 'agt_1', agentVersionId: 'agv_1',
    agentSnapshot: {} as never, modelBindingId: 'mbd_1',
    trigger: { type: 'user' }, principal: {}, budget: DEFAULT_BUDGET,
  };

  it('returns the existing run for a repeated idempotency key', async () => {
    // A double-clicked button must not start a second run that spends budget
    // and repeats tool calls.
    const existing = { _id: 'run_existing' };
    const { db, of } = recorder({ 'runs.findOne': existing });
    const run = await new RunRepository(db, WS).create({ ...input, idempotencyKey: 'k1' });
    expect(run).toBe(existing);
    expect(of('runs.insertOne')).toHaveLength(0);
  });

  it('creates a run when no key is supplied', async () => {
    const { db, of } = recorder();
    await new RunRepository(db, WS).create(input);
    expect(of('runs.insertOne')).toHaveLength(1);
  });

  it('starts a run queued and unleased', async () => {
    const { db, of } = recorder();
    await new RunRepository(db, WS).create(input);
    const doc = of('runs.insertOne')[0]?.doc as { status: string; lease: unknown; attempts: number };
    expect(doc.status).toBe('queued');
    expect(doc.lease).toBeNull();
    expect(doc.attempts).toBe(0);
  });
});

describe('run writes are lease-guarded', () => {
  it('guards consumption accounting with the lease token', async () => {
    const { db, of } = recorder();
    await new RunRepository(db, WS).recordConsumption('run_1', 'lse_abc', { steps: 1, costUsd: 0.5 });
    const call = of('runs.updateOne')[0];
    // workspaceId is injected by the scoping layer; asserting it here also
    // confirms the guard's requirement is satisfied on this path.
    expect(call?.filter).toEqual({ _id: 'run_1', 'lease.token': 'lse_abc', workspaceId: WS });
  });

  it('accumulates spend with $inc, so concurrent steps do not overwrite each other', async () => {
    const { db, of } = recorder();
    await new RunRepository(db, WS).recordConsumption(
      'run_1', 'lse_abc', { steps: 1, tokens: 100 },
      { inputTokens: 90, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
    const update = of('runs.updateOne')[0]?.update as { $inc: Record<string, number> };
    expect(update.$inc['consumed.steps']).toBe(1);
    expect(update.$inc['usage.inputTokens']).toBe(90);
  });

  it('refuses to append a step without the lease', async () => {
    // The executor lost its lease mid-slice; it must stop, not keep writing.
    const { db } = recorder();
    await expect(
      new RunRepository(db, WS).appendStep('run_1', 'lse_stale', {
        type: 'model_call', status: 'succeeded', startedAt: new Date(),
      } as never),
    ).rejects.toThrow(/lease not held/);
  });
});

describe('approval decisions happen once', () => {
  it('guards on an undecided approval', async () => {
    // Two reviewers clicking at once, or one double-click, must not let an
    // Approve overwrite a Deny.
    const { db, of } = recorder();
    await new RunRepository(db, WS).decideApproval('apr_1', 'approve', 'usr_1');
    expect(of('approvals.updateOne')[0]?.filter)
      .toEqual({ _id: 'apr_1', decision: null, workspaceId: WS });
  });

  it('reports false when the approval was already decided', async () => {
    const { db } = recorder({ 'approvals.matched': 0 });
    expect(await new RunRepository(db, WS).decideApproval('apr_1', 'deny', 'usr_2')).toBe(false);
  });
});

describe('credential storage', () => {
  it('binds the ciphertext to the id it will be stored under', async () => {
    // The AAD includes the credential id, so the row has to be named before it
    // is encrypted — otherwise the blob could be moved between rows.
    const { db, of } = recorder();
    const repo = new CredentialRepository(db, WS, ephemeralKeyProvider());
    await repo.store({ name: 'k', kind: 'api_key', plaintext: 'sk-secret', createdBy: 'usr_1' });

    const doc = of('credentials.insertOne')[0]?.doc as Record<string, unknown>;
    expect(typeof doc['_id']).toBe('string');
    expect(doc['ciphertext']).toBeInstanceOf(Uint8Array);
    // Plaintext appears nowhere in the stored document.
    expect(JSON.stringify(doc)).not.toContain('sk-secret');
  });

  it('round-trips through storage and returns a short-lived handle', async () => {
    const keyProvider = ephemeralKeyProvider();
    const { db, of } = recorder();
    const write = new CredentialRepository(db, WS, keyProvider);
    await write.store({ name: 'k', kind: 'api_key', plaintext: 'sk-secret', createdBy: 'usr_1' });
    const stored = of('credentials.insertOne')[0]?.doc as Record<string, unknown>;

    const read = new CredentialRepository(
      recorder({ 'credentials.findOne': stored }).db, WS, keyProvider,
    );
    const secret = await read.resolve(stored['_id'] as string);
    expect(secret).toBeInstanceOf(EphemeralSecret);
    expect(secret?.expose()).toBe('sk-secret');
  });

  it('refuses to resolve a revoked credential', async () => {
    // Revocation must take effect immediately, not when a cache expires.
    const { db } = recorder({
      'credentials.findOne': { _id: 'crd_1', kind: 'api_key', revokedAt: new Date() },
    });
    const repo = new CredentialRepository(db, WS, ephemeralKeyProvider());
    expect(await repo.resolve('crd_1')).toBeNull();
  });

  it('never selects secret material into a list view', async () => {
    const { db, of } = recorder();
    await new CredentialRepository(db, WS, ephemeralKeyProvider()).list();
    const projection = (of('credentials.find')[0]?.options as { projection: Record<string, number> })
      .projection;
    expect(projection).toMatchObject({ ciphertext: 0, wrappedDek: 0, iv: 0, authTag: 0 });
  });
});

describe('usage rollups', () => {
  it('accumulates into a deterministic day bucket with $inc', async () => {
    // Concurrent runs finishing at once must each add their spend rather than
    // overwriting one another.
    const { db, of } = recorder();
    await new UsageRepository(db, WS).record(
      'mbd_1',
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 },
      0.25,
      new Date('2026-09-15T12:00:00Z'),
    );
    const call = of('usageDaily.updateOne')[0];
    expect(call?.filter).toEqual({ _id: `${WS}:2026-09-15:mbd_1`, workspaceId: WS });
    const update = call?.update as { $inc: Record<string, number> };
    expect(update.$inc['costUsd']).toBe(0.25);
    expect(update.$inc['runCount']).toBe(1);
    expect((call?.options as { upsert: boolean }).upsert).toBe(true);
  });
});

describe('audit log', () => {
  it('redacts metadata at the repository, not at each call site', async () => {
    // The one call site that forgets would write a secret into the collection
    // that is never deleted.
    const { db, of } = recorder();
    await new AuditRepository(db, WS).write({
      actor: { type: 'user', id: 'usr_1' },
      action: 'credential.created',
      subject: { type: 'credential', id: 'crd_1' },
      metadata: { apiKey: 'sk-live-should-not-persist' },
    });
    const doc = of('auditLog.insertOne')[0]?.doc as Record<string, unknown>;
    expect(JSON.stringify(doc)).not.toContain('should-not-persist');
    expect(JSON.stringify(doc)).toContain('[redacted]');
  });
});
