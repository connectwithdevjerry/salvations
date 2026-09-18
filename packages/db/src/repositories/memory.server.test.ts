/**
 * Memory against a real MongoDB.
 *
 * The claims worth making are all about concurrency and history, and a fake
 * collection can demonstrate neither:
 *
 *  - two corrections arriving together leave exactly ONE current belief, not
 *    two rows both claiming to be true;
 *  - superseding is reported only when something was actually closed;
 *  - the history survives the correction that replaced it;
 *  - forgetting closes rather than deletes, so the audit trail remains.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MemoryRepository } from './memory';
import { syncIndexes } from '../indexes';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_memory`;
const WS = 'wks_memory';
const AGENT = 'agt_1';

let client: MongoClient | undefined;
let db: Db;
let repo: MemoryRepository;

const remember = (over: Partial<Parameters<MemoryRepository['remember']>[0]> = {}) =>
  repo.remember({
    agentId: AGENT,
    kind: 'preference',
    key: undefined,
    content: 'Prefers tables over prose.',
    importance: 0.5,
    sourceRunId: 'run_1',
    createdBy: 'usr_1',
    embeddings: undefined,
    ...over,
  });

describe.skipIf(URI === undefined || URI === '')('memory against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
    repo = new MemoryRepository(db, WS);
  });

  afterAll(async () => { await client?.close(); });

  beforeEach(async () => { await db.collection('memoryEntries').deleteMany({}); });

  it('does not claim to supersede on the first memory under a key', async () => {
    // Telling somebody you have replaced what you previously knew, when you
    // knew nothing, is a small lie that makes the rest harder to trust.
    const { superseded } = await remember({ key: 'reporting_format' });
    expect(superseded).toBe(false);
  });

  it('supersedes the second memory under the same key', async () => {
    await remember({ key: 'reporting_format', content: 'Prefers prose.' });
    const { superseded } = await remember({ key: 'reporting_format', content: 'Prefers tables.' });

    expect(superseded).toBe(true);
    const current = await repo.current(AGENT);
    expect(current).toHaveLength(1);
    expect(current[0]?.content).toBe('Prefers tables.');
  });

  it('leaves exactly one current belief when two corrections race', async () => {
    /*
     * The reason supersession is a conditional write. A read-then-write would
     * let both see the same current entry, close it twice and leave two rows
     * claiming to be true — after which recall returns a belief and its
     * replacement side by side and the agent contradicts itself.
     */
    await remember({ key: 'timezone', content: 'UTC' });

    await Promise.all([
      remember({ key: 'timezone', content: 'Europe/London' }),
      remember({ key: 'timezone', content: 'America/New_York' }),
      remember({ key: 'timezone', content: 'Asia/Tokyo' }),
    ]);

    const current = (await repo.current(AGENT)).filter((e) => e.key === 'timezone');
    expect(current).toHaveLength(1);
  });

  it('keeps the belief it replaced', async () => {
    await remember({ key: 'reporting_format', content: 'Prefers prose.' });
    await remember({ key: 'reporting_format', content: 'Prefers tables.' });

    const history = await repo.history(AGENT, 'reporting_format');
    expect(history).toHaveLength(2);
    // Newest first, and the older one closed with a pointer to what replaced it.
    expect(history[0]?.content).toBe('Prefers tables.');
    expect(history[1]?.validTo).toBeInstanceOf(Date);
    expect(history[1]?.supersededBy).toBe(history[0]?._id);
  });

  it('never supersedes a memory stored without a key', async () => {
    // Two memories can read alike and mean different things. Replacing on
    // content would destroy one silently.
    await remember({ content: 'Prefers tables in reports.' });
    await remember({ content: 'Prefers tables in email.' });

    expect(await repo.current(AGENT)).toHaveLength(2);
  });

  it('forgets by closing, not deleting', async () => {
    const { entry } = await remember();
    expect(await repo.forget(AGENT, entry._id)).toBe(true);

    expect(await repo.current(AGENT)).toHaveLength(0);
    // The record that it was once believed survives, which is what an audit
    // needs most.
    const stored = await repo.findById(entry._id);
    expect(stored).not.toBeNull();
    expect(stored?.validTo).toBeInstanceOf(Date);
  });

  it('does not report success forgetting something already forgotten', async () => {
    // Reporting success for a no-op teaches the agent a memory is gone when it
    // is not.
    const { entry } = await remember();
    expect(await repo.forget(AGENT, entry._id)).toBe(true);
    expect(await repo.forget(AGENT, entry._id)).toBe(false);
  });

  it('refuses to forget another agent memory', async () => {
    const { entry } = await remember();
    expect(await repo.forget('agt_other', entry._id)).toBe(false);
    expect(await repo.current(AGENT)).toHaveLength(1);
  });

  it('keeps one agent memories out of another agent recall', async () => {
    await remember({ content: 'Belongs to agent one.' });
    await repo.remember({
      agentId: 'agt_two', kind: 'note', key: undefined, content: 'Belongs to agent two.',
      importance: 0.5, sourceRunId: undefined, createdBy: undefined, embeddings: undefined,
    });

    const mine = await repo.current(AGENT);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.content).toBe('Belongs to agent one.');
  });

  it('keeps one workspace memories out of another workspace', async () => {
    const { entry } = await remember();
    const other = new MemoryRepository(db, 'wks_other');

    expect(await other.current(AGENT)).toHaveLength(0);
    expect(await other.findById(entry._id)).toBeNull();
    expect(await other.forget(AGENT, entry._id)).toBe(false);
  });

  it('adds a vector without disturbing one from another model', async () => {
    /*
     * Re-embedding on a new model must be an additive write. Overwriting the
     * whole field would silently drop every vector from the previous model and
     * turn every older memory unsearchable by similarity.
     */
    const { entry } = await remember();
    await repo.attachEmbedding(entry._id, 'openai_small', [0.1, 0.2]);
    await repo.attachEmbedding(entry._id, 'google_large', [0.3, 0.4, 0.5]);

    const stored = await repo.findById(entry._id);
    expect(stored?.embeddings?.['openai_small']).toEqual([0.1, 0.2]);
    expect(stored?.embeddings?.['google_large']).toEqual([0.3, 0.4, 0.5]);
  });
});
