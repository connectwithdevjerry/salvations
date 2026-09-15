import { describe, expect, it } from 'vitest';
import type { Collection } from 'mongodb';
import { ScopedCollection, ScopedDb, type TenantDocument } from './scoped.js';

interface Recorded { op: string; args: unknown[] }

/**
 * A stand-in for the driver collection that records what it was asked to do.
 * The point of these tests is what reaches the driver, not what the server does.
 */
function fakeCollection<T extends TenantDocument>() {
  const calls: Recorded[] = [];
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
    return { toArray: async () => [], then: undefined };
  };
  const collection = {
    findOne: async (...a: unknown[]) => { calls.push({ op: 'findOne', args: a }); return null; },
    find: record('find'),
    countDocuments: async (...a: unknown[]) => { calls.push({ op: 'countDocuments', args: a }); return 0; },
    insertOne: async (...a: unknown[]) => { calls.push({ op: 'insertOne', args: a }); return {}; },
    insertMany: async (...a: unknown[]) => { calls.push({ op: 'insertMany', args: a }); return {}; },
    updateOne: async (...a: unknown[]) => { calls.push({ op: 'updateOne', args: a }); return {}; },
    updateMany: async (...a: unknown[]) => { calls.push({ op: 'updateMany', args: a }); return {}; },
    findOneAndUpdate: async (...a: unknown[]) => { calls.push({ op: 'findOneAndUpdate', args: a }); return null; },
    deleteOne: async (...a: unknown[]) => { calls.push({ op: 'deleteOne', args: a }); return {}; },
    deleteMany: async (...a: unknown[]) => { calls.push({ op: 'deleteMany', args: a }); return {}; },
    aggregate: (...a: unknown[]) => { calls.push({ op: 'aggregate', args: a }); return { toArray: async () => [] }; },
    watch: (...a: unknown[]) => { calls.push({ op: 'watch', args: a }); return {}; },
  } as unknown as Collection<T>;
  return { collection, calls };
}

interface Doc extends TenantDocument { _id: string; name?: string; status?: string }

const WS = 'wks_1';
const scoped = () => {
  const { collection, calls } = fakeCollection<Doc>();
  return { sc: new ScopedCollection<Doc>(collection, WS), calls };
};

describe('ScopedCollection — every read is scoped', () => {
  it('injects the workspace into an empty filter', async () => {
    const { sc, calls } = scoped();
    await sc.findOne();
    expect(calls[0]?.args[0]).toEqual({ workspaceId: WS });
  });

  it('merges the workspace into a caller filter', async () => {
    const { sc, calls } = scoped();
    await sc.findOne({ status: 'queued' });
    expect(calls[0]?.args[0]).toEqual({ status: 'queued', workspaceId: WS });
  });

  it('overrides a caller-supplied workspaceId — the caller does not get to choose', async () => {
    const { sc, calls } = scoped();
    await sc.findOne({ workspaceId: 'wks_ATTACKER' } as never);
    expect(calls[0]?.args[0]).toEqual({ workspaceId: WS });
  });

  it('scopes find, count, update, delete and findOneAndUpdate alike', async () => {
    const { sc, calls } = scoped();
    await sc.find({ a: 1 } as never);
    await sc.countDocuments({ a: 1 } as never);
    await sc.updateOne({ a: 1 } as never, { $set: { name: 'x' } });
    await sc.updateMany({ a: 1 } as never, { $set: { name: 'x' } });
    await sc.deleteOne({ a: 1 } as never);
    await sc.deleteMany({ a: 1 } as never);
    await sc.findOneAndUpdate({ a: 1 } as never, { $set: { name: 'x' } });
    for (const call of calls) {
      expect(call.args[0]).toMatchObject({ workspaceId: WS });
    }
    expect(calls).toHaveLength(7);
  });
});

describe('ScopedCollection — every write is stamped', () => {
  it('stamps insertOne even when the caller omits the workspace', async () => {
    const { sc, calls } = scoped();
    const doc = await sc.insertOne({ _id: 'a', name: 'x' });
    expect(doc.workspaceId).toBe(WS);
    expect(calls[0]?.args[0]).toMatchObject({ workspaceId: WS });
  });

  it('overrides a forged workspace on insert', async () => {
    const { sc } = scoped();
    const doc = await sc.insertOne({ _id: 'a', workspaceId: 'wks_ATTACKER' });
    expect(doc.workspaceId).toBe(WS);
  });

  it('stamps every document in insertMany', async () => {
    const { sc } = scoped();
    const docs = await sc.insertMany([{ _id: 'a' }, { _id: 'b', workspaceId: 'wks_X' }]);
    expect(docs.map((d) => d.workspaceId)).toEqual([WS, WS]);
  });

  it('short-circuits an empty insertMany without touching the driver', async () => {
    const { sc, calls } = scoped();
    expect(await sc.insertMany([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('ScopedCollection — aggregation gating', () => {
  it('prepends a workspace $match', async () => {
    const { sc, calls } = scoped();
    await sc.aggregate([{ $group: { _id: '$status' } }]);
    expect(calls[0]?.args[0]).toEqual([
      { $match: { workspaceId: WS } },
      { $group: { _id: '$status' } },
    ]);
  });

  it('refuses a search stage, which a prepended $match cannot constrain', async () => {
    // The tenant filter has to live INSIDE a search stage; gating it from
    // outside would silently search every tenant's data and filter afterwards.
    const { sc } = scoped();
    await expect(sc.aggregate([{ $vectorSearch: { index: 'i' } }])).rejects.toThrow(/inside/);
    await expect(sc.aggregate([{ $search: { text: {} } }])).rejects.toThrow(/inside/);
  });

  it('scopes change streams to the workspace', () => {
    const { sc, calls } = scoped();
    sc.watch();
    expect(calls[0]?.args[0]).toEqual([{ $match: { 'fullDocument.workspaceId': WS } }]);
  });
});

describe('ScopedDb', () => {
  const db = { collection: () => fakeCollection().collection } as never;

  it('hands out scoped collections for tenant collections', () => {
    const sdb = new ScopedDb(db, WS);
    expect(sdb.collection('conversations')).toBeInstanceOf(ScopedCollection);
    expect(sdb.workspaceId).toBe(WS);
  });

  it('refuses collections owned by the auth library', () => {
    const sdb = new ScopedDb(db, WS);
    expect(() => sdb.collection('session')).toThrow(/not a tenant-scoped collection/);
  });

  it('refuses the mixed platform catalog', () => {
    const sdb = new ScopedDb(db, WS);
    expect(() => sdb.collection('mcpServers')).toThrow(/not a tenant-scoped collection/);
  });
});
