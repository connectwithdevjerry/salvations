import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { ChannelRepository } from './channels';

/**
 * Records every command instead of running one.
 *
 * The behaviour worth pinning here is what the FILTERS say — a claim that
 * checks expiry in the filter and one that checks it in JavaScript look
 * identical from the outside and are not the same under concurrency.
 */
function recorder(results: Record<string, unknown> = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const collection = (name: string) => ({
    findOne: async (...args: unknown[]) => {
      calls.push({ op: `${name}.findOne`, args });
      return results[`${name}.findOne`] ?? null;
    },
    find: async (...args: unknown[]) => {
      calls.push({ op: `${name}.find`, args });
      return results[`${name}.find`] ?? [];
    },
    insertOne: async (...args: unknown[]) => {
      calls.push({ op: `${name}.insertOne`, args });
      const thrown = results[`${name}.insertOne.throws`];
      if (thrown !== undefined) throw thrown;
      return args[0];
    },
    updateOne: async (...args: unknown[]) => {
      calls.push({ op: `${name}.updateOne`, args });
      return { acknowledged: true };
    },
    findOneAndUpdate: async (...args: unknown[]) => {
      calls.push({ op: `${name}.findOneAndUpdate`, args });
      return results[`${name}.findOneAndUpdate`] ?? null;
    },
    deleteOne: async (...args: unknown[]) => { calls.push({ op: `${name}.deleteOne`, args }); },
    deleteMany: async (...args: unknown[]) => { calls.push({ op: `${name}.deleteMany`, args }); },
  });

  const db = {
    collection: (name: string) => collection(name),
  } as unknown as Db;

  return {
    db,
    calls,
    of: (op: string) => calls.filter((c) => c.op === op),
  };
}

const WS = 'wks_1';

describe('claiming a connection', () => {
  it('matches the code and the expiry in one filter', async () => {
    const { db, of } = recorder({ 'channels.findOneAndUpdate': { _id: 'chn_1' } });
    await new ChannelRepository(db, WS).claim('chn_1', 'ABC123', 'chat_9');

    const [filter] = of('channels.findOneAndUpdate')[0]?.args as [Record<string, unknown>];
    expect(filter['connect.code']).toBe('ABC123');
    // In the FILTER, not read back and compared afterwards: two simultaneous
    // claims against a read-then-write would both see an unexpired code.
    expect(filter['connect.expiresAt']).toMatchObject({ $gt: expect.any(Date) });
  });

  it('clears the code in the same write that connects', async () => {
    const { db, of } = recorder({ 'channels.findOneAndUpdate': { _id: 'chn_1' } });
    await new ChannelRepository(db, WS).claim('chn_1', 'ABC123', 'chat_9');

    const [, update] = of('channels.findOneAndUpdate')[0]?.args as [unknown, { $set: Record<string, unknown> }];
    expect(update.$set['status']).toBe('connected');
    expect(update.$set['verifiedChatRef']).toBe('chat_9');
    // A code left behind is a code that can be replayed.
    expect(update.$set['connect']).toBeNull();
  });

  it('returns null when nothing matched', async () => {
    // A wrong code, an expired one and a replay are all the same answer, and
    // distinguishing them for the caller would leak which it was.
    const { db } = recorder();
    expect(await new ChannelRepository(db, WS).claim('chn_1', 'NOPE', 'chat_9')).toBeNull();
  });
});

describe('claiming a delivery', () => {
  it('is true the first time', async () => {
    const { db } = recorder();
    expect(await new ChannelRepository(db, WS).claimDelivery('chn_1', 'm1')).toBe(true);
  });

  it('is false for a redelivery, not an error', async () => {
    // Every one of these platforms retries a slow request. A duplicate key here
    // is the mechanism working, so it must not surface as a failure.
    const duplicate = Object.assign(new Error('E11000'), { code: 11000 });
    const { db } = recorder({ 'channelEvents.insertOne.throws': duplicate });
    expect(await new ChannelRepository(db, WS).claimDelivery('chn_1', 'm1')).toBe(false);
  });

  it('still throws on a failure that is not a collision', async () => {
    // A connection error must not be mistaken for "already handled" — that
    // would silently drop the message.
    const { db } = recorder({ 'channelEvents.insertOne.throws': new Error('connection reset') });
    await expect(new ChannelRepository(db, WS).claimDelivery('chn_1', 'm1'))
      .rejects.toThrow('connection reset');
  });
});

describe('connecting', () => {
  it('replaces an existing connection for the same platform', async () => {
    // Reconnecting after rotating a token is the common case. Failing on the
    // unique index would make people disconnect first for no reason.
    const { db, of } = recorder();
    await new ChannelRepository(db, WS).connect({
      type: 'telegram', agentId: 'agt_1', modelBindingId: 'mbd_1',
      tokenCredentialId: 'crd_1', identity: { handle: '@b', displayName: 'b', botRef: '1' },
      connectCode: 'ABC', connectCodeTtlMs: 1000, createdBy: 'usr_1',
    });

    expect(of('channels.deleteOne')).toHaveLength(1);
    const doc = of('channels.insertOne')[0]?.args[0] as { status: string; verifiedChatRef: null };
    // Never connected on creation. A token proves nothing about who pasted it.
    expect(doc.status).toBe('pending_verification');
    expect(doc.verifiedChatRef).toBeNull();
  });
});

describe('disconnecting', () => {
  it('forgets the threads as well as the connection', async () => {
    // Leaving identity rows behind would route a later reconnection's messages
    // into conversations from the previous one.
    const { db, of } = recorder();
    await new ChannelRepository(db, WS).disconnect('chn_1');

    expect(of('channels.deleteOne')).toHaveLength(1);
    expect(of('channelIdentities.deleteMany')).toHaveLength(1);
  });
});
