/**
 * The channel repository against a real MongoDB.
 *
 * Gated on MONGODB_URI, because every claim worth making here is about what the
 * DATABASE does under contention, and a fake collection cannot demonstrate any
 * of it:
 *
 *  - a redelivery collides on a unique index rather than starting a second run;
 *  - two simultaneous claims of the same connect code produce exactly one
 *    winner, because the expiry lives in the filter;
 *  - an expired code claims nothing at all;
 *  - two people writing at once end up in one thread, not two.
 *
 * Each of those passes trivially against a stub and is the actual failure mode
 * in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { ChannelRepository } from './channels';
import { syncIndexes } from '../indexes';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_channels`;
const WS = 'wks_channels';

let client: MongoClient | undefined;
let db: Db;
let repo: ChannelRepository;

const identity = { handle: '@hive_bot', displayName: 'HIVE', botRef: '1' };

const connect = (code: string, ttlMs = 60_000) => repo.connect({
  type: 'telegram',
  agentId: 'agt_1',
  modelBindingId: 'mbd_1',
  tokenCredentialId: 'crd_1',
  identity,
  connectCode: code,
  connectCodeTtlMs: ttlMs,
  createdBy: 'usr_1',
});

describe.skipIf(URI === undefined || URI === '')('channels against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
    repo = new ChannelRepository(db, WS);
  });

  afterAll(async () => { await client?.close(); });

  beforeEach(async () => {
    await db.collection('channels').deleteMany({});
    await db.collection('channelIdentities').deleteMany({});
    await db.collection('channelEvents').deleteMany({});
  });

  it('accepts a delivery once and refuses every redelivery', async () => {
    const row = await connect('ABCD1234');

    const outcomes = await Promise.all([
      repo.claimDelivery(row._id, 'msg_1'),
      repo.claimDelivery(row._id, 'msg_1'),
      repo.claimDelivery(row._id, 'msg_1'),
    ]);

    // Exactly one, even when they arrive together — which is precisely how a
    // platform's retry storm arrives.
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('treats a different message on the same channel as new', async () => {
    const row = await connect('ABCD1234');
    expect(await repo.claimDelivery(row._id, 'msg_1')).toBe(true);
    expect(await repo.claimDelivery(row._id, 'msg_2')).toBe(true);
  });

  it('has exactly one winner when a code is claimed twice at once', async () => {
    const row = await connect('ABCD1234');

    const results = await Promise.all([
      repo.claim(row._id, 'ABCD1234', 'chat_a'),
      repo.claim(row._id, 'ABCD1234', 'chat_b'),
    ]);

    // A read-then-write would let both through and leave the connection bound
    // to whichever wrote last.
    expect(results.filter((r) => r !== null)).toHaveLength(1);

    const stored = await repo.findById(row._id);
    expect(stored?.status).toBe('connected');
    expect(stored?.connect).toBeNull();
    expect(['chat_a', 'chat_b']).toContain(stored?.verifiedChatRef);
  });

  it('claims nothing with an expired code', async () => {
    const row = await connect('ABCD1234', -1_000);

    expect(await repo.claim(row._id, 'ABCD1234', 'chat_a')).toBeNull();
    expect((await repo.findById(row._id))?.status).toBe('pending_verification');
  });

  it('claims nothing with the wrong code', async () => {
    const row = await connect('ABCD1234');
    expect(await repo.claim(row._id, 'WRONG999', 'chat_a')).toBeNull();
  });

  it('cannot be claimed twice, even later', async () => {
    const row = await connect('ABCD1234');
    expect(await repo.claim(row._id, 'ABCD1234', 'chat_a')).not.toBeNull();
    // The code was cleared by the first claim, so a replay finds nothing.
    expect(await repo.claim(row._id, 'ABCD1234', 'chat_b')).toBeNull();
    expect((await repo.findById(row._id))?.verifiedChatRef).toBe('chat_a');
  });

  it('gives one person one thread when two messages race', async () => {
    const row = await connect('ABCD1234');

    const [first, second] = await Promise.all([
      repo.linkIdentity({
        channelId: row._id, externalUserId: 'tg_9', chatRef: 'chat_9',
        conversationId: 'cnv_first', label: '@ada',
      }),
      repo.linkIdentity({
        channelId: row._id, externalUserId: 'tg_9', chatRef: 'chat_9',
        conversationId: 'cnv_second', label: '@ada',
      }),
    ]);

    // Both callers see the same thread. Two rows here would mean a person's
    // messages silently splitting into two conversations.
    expect(first._id).toBe(second._id);
    expect(first.conversationId).toBe(second.conversationId);
    expect(await db.collection('channelIdentities').countDocuments({})).toBe(1);
  });

  it('replaces rather than colliding when the same platform reconnects', async () => {
    const first = await connect('AAAA1111');
    const second = await connect('BBBB2222');

    expect(second._id).not.toBe(first._id);
    expect(await db.collection('channels').countDocuments({ type: 'telegram' })).toBe(1);
  });

  it('forgets the threads when a connection is disconnected', async () => {
    const row = await connect('ABCD1234');
    await repo.linkIdentity({
      channelId: row._id, externalUserId: 'tg_9', chatRef: 'chat_9',
      conversationId: 'cnv_1', label: '@ada',
    });

    await repo.disconnect(row._id);

    // A stale identity row would route a later reconnection's messages into a
    // conversation from the previous one.
    expect(await db.collection('channelIdentities').countDocuments({})).toBe(0);
    expect(await repo.findById(row._id)).toBeNull();
  });

  it('keeps one workspace out of another workspace connections', async () => {
    const row = await connect('ABCD1234');
    const other = new ChannelRepository(db, 'wks_other');

    expect(await other.findById(row._id)).toBeNull();
    expect(await other.findByType('telegram')).toBeNull();
    // And a claim from the wrong workspace must not succeed either.
    expect(await other.claim(row._id, 'ABCD1234', 'chat_a')).toBeNull();
  });
});
