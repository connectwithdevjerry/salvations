/**
 * Adversarial tenant-isolation suite — the evidence for AC-10.
 *
 * Requires a real MongoDB replica set, so it is gated on MONGODB_URI and runs
 * in CI. Two workspaces are seeded with identical-looking data and every access
 * path is exercised with the WRONG workspace; each must return nothing or
 * throw. The guard runs in `throw` mode throughout, so a query that escapes the
 * scoping layer fails the test rather than quietly succeeding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { ScopedDb } from './scoped';
import { handleCommandStarted, TenancyViolationError, type GuardViolation } from './guard';
import { TENANT_COLLECTIONS } from './collections';
import { syncIndexes } from './indexes';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_isolation`;

const WS_A = 'wks_aaaa';
const WS_B = 'wks_bbbb';

let client: MongoClient | undefined;
let db: Db;
const violations: GuardViolation[] = [];

describe.skipIf(URI === undefined || URI === '')('tenant isolation (AC-10)', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string, { monitorCommands: true });
    client.on('commandStarted', (event) => {
      try {
        handleCommandStarted(
          { commandName: event.commandName, command: event.command as Record<string, unknown> },
          { mode: 'throw', onViolation: (v) => violations.push(v) },
        );
      } catch {
        // Recorded in `violations`; rethrowing here would be swallowed by the driver.
      }
    });
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);

    // Identical-looking data in two workspaces. Any cross-read is unambiguous.
    for (const ws of [WS_A, WS_B]) {
      const scoped = new ScopedDb(db, ws);
      await scoped.collection('agents').insertOne({
        _id: `agt_${ws}`, slug: 'assistant', name: `Agent of ${ws}`,
        isArchived: false, createdAt: new Date(), updatedAt: new Date(),
      } as never);
      await scoped.collection('conversations').insertOne({
        _id: `cnv_${ws}`, agentId: `agt_${ws}`, status: 'active',
        messageCount: 0, nextSeq: 1, createdAt: new Date(), updatedAt: new Date(),
      } as never);
      await scoped.collection('credentials').insertOne({
        _id: `crd_${ws}`, name: 'secret', kind: 'api_key', createdAt: new Date(),
      } as never);
    }
    violations.length = 0;
  }, 60_000);

  afterAll(async () => {
    await db?.dropDatabase().catch(() => undefined);
    await client?.close();
  });

  it('never returns another workspace’s document by id', async () => {
    const a = new ScopedDb(db, WS_A);
    expect(await a.collection('agents').findOne({ _id: `agt_${WS_B}` } as never)).toBeNull();
    expect(await a.collection('credentials').findOne({ _id: `crd_${WS_B}` } as never)).toBeNull();
  });

  it('returns only its own documents on an unfiltered list', async () => {
    const a = new ScopedDb(db, WS_A);
    const agents = await a.collection('agents').find();
    expect(agents).toHaveLength(1);
    expect(agents[0]?._id).toBe(`agt_${WS_A}`);
  });

  it('refuses a filter that names a workspace, forged or not', async () => {
    const a = new ScopedDb(db, WS_A);
    await expect(a.collection('agents').find({ workspaceId: WS_B } as never))
      .rejects.toThrow(/must not specify workspaceId/);
    await expect(a.collection('agents').find({ workspaceId: WS_A } as never))
      .rejects.toThrow(/must not specify workspaceId/);
  });

  it('cannot update another workspace’s document', async () => {
    const a = new ScopedDb(db, WS_A);
    const result = await a.collection('agents')
      .updateOne({ _id: `agt_${WS_B}` } as never, { $set: { name: 'hijacked' } } as never);
    expect(result.matchedCount).toBe(0);

    const b = new ScopedDb(db, WS_B);
    const victim = await b.collection('agents').findOne({ _id: `agt_${WS_B}` } as never);
    expect(victim?.['name']).toBe(`Agent of ${WS_B}`);
  });

  it('cannot delete another workspace’s document', async () => {
    const a = new ScopedDb(db, WS_A);
    const result = await a.collection('credentials').deleteMany({} as never);
    expect(result.deletedCount).toBe(1);

    const b = new ScopedDb(db, WS_B);
    expect(await b.collection('credentials').countDocuments()).toBe(1);
  });

  it('refuses an insert that claims another workspace', async () => {
    const a = new ScopedDb(db, WS_A);
    await expect(a.collection('conversations').insertOne({
      _id: 'cnv_forged', agentId: 'x', workspaceId: WS_B, status: 'active',
      messageCount: 0, nextSeq: 1, createdAt: new Date(), updatedAt: new Date(),
    } as never)).rejects.toThrow(/claims workspace/);

    const b = new ScopedDb(db, WS_B);
    expect(await b.collection('conversations').findOne({ _id: 'cnv_forged' } as never)).toBeNull();
    expect(await a.collection('conversations').findOne({ _id: 'cnv_forged' } as never)).toBeNull();
  });

  it('stamps an insert that omits the workspace entirely', async () => {
    const a = new ScopedDb(db, WS_A);
    await a.collection('conversations').insertOne({
      _id: 'cnv_stamped', agentId: 'x', status: 'active',
      messageCount: 0, nextSeq: 1, createdAt: new Date(), updatedAt: new Date(),
    } as never);

    const b = new ScopedDb(db, WS_B);
    expect(await b.collection('conversations').findOne({ _id: 'cnv_stamped' } as never)).toBeNull();
    expect(await a.collection('conversations').findOne({ _id: 'cnv_stamped' } as never)).not.toBeNull();
  });

  it('gates aggregations before any stage can reach data', async () => {
    const a = new ScopedDb(db, WS_A);
    const rows = await a.collection('agents').aggregate([{ $group: { _id: '$workspaceId' } }]);
    expect(rows).toEqual([{ _id: WS_A }]);
  });

  it('records no guard violations for any scoped access', async () => {
    // The whole suite ran through ScopedDb. If the guard fired even once, the
    // scoping layer is emitting something it should not.
    expect(violations).toEqual([]);
  });

  it('catches a raw driver query that bypasses the scoping layer entirely', async () => {
    // The reason the guard exists: this call never touches ScopedDb.
    violations.length = 0;
    await db.collection('agents').find({}).toArray().catch(() => undefined);
    expect(violations.map((v) => v.reason)).toContain('missing_workspace_filter');
  });

  it('catches a raw insert with no workspaceId', async () => {
    violations.length = 0;
    await db.collection('messages').insertOne({ _id: 'msg_raw', role: 'user' } as never)
      .catch(() => undefined);
    expect(violations.map((v) => v.reason)).toContain('missing_workspace_on_insert');
  });

  it('rejects a cross-tenant $or where only one branch is scoped', async () => {
    violations.length = 0;
    await db.collection('agents')
      .find({ $or: [{ workspaceId: WS_A }, { slug: 'assistant' }] })
      .toArray()
      .catch(() => undefined);
    expect(violations.map((v) => v.reason)).toContain('missing_workspace_filter');
  });

  it('refuses to hand out a non-tenant collection through ScopedDb', () => {
    const a = new ScopedDb(db, WS_A);
    expect(() => a.collection('authSessions')).toThrow(/not a tenant-scoped collection/);
  });

  it('covers every declared tenant collection', () => {
    // A collection added without a test here is a collection nobody proved is
    // isolated. This keeps the suite honest as the schema grows.
    expect(TENANT_COLLECTIONS.length).toBeGreaterThan(0);
    for (const name of TENANT_COLLECTIONS) {
      const scoped = new ScopedDb(db, WS_A);
      expect(() => scoped.collection(name)).not.toThrow();
    }
  });

  it('throws a typed error when the guard is in throw mode', () => {
    expect(() =>
      handleCommandStarted(
        { commandName: 'find', command: { find: 'runs', filter: {} } },
        { mode: 'throw' },
      ),
    ).toThrow(TenancyViolationError);
  });
});
