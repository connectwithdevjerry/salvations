/**
 * Schedule claiming against a real MongoDB.
 *
 * One property matters here and a fake cannot demonstrate it: when two ticks
 * overlap — two instances, a retry, a slow run bleeding into the next minute —
 * exactly one of them may fire an occurrence. A read-then-compare-then-write
 * passes every unit test and fires twice in production, which for a scheduled
 * agent means paying twice and possibly acting twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { ScheduleRepository, FAILURE_LIMIT, enabledSchedules } from './schedules';
import { syncIndexes } from '../indexes';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_schedules`;
const WS = 'wks_schedules';

let client: MongoClient | undefined;
let db: Db;
let repo: ScheduleRepository;

const create = () => repo.create({
  name: 'Morning briefing',
  expression: '0 9 * * *',
  timeZone: 'UTC',
  agentId: 'agt_1',
  modelBindingId: 'mbd_1',
  prompt: 'Summarise overnight.',
  createdBy: 'usr_1',
});

describe.skipIf(URI === undefined || URI === '')('schedules against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
    repo = new ScheduleRepository(db, WS);
  });

  afterAll(async () => { await client?.close(); });

  beforeEach(async () => { await db.collection('schedules').deleteMany({}); });

  it('lets exactly one of several simultaneous ticks fire an occurrence', async () => {
    const schedule = await create();
    const occurrence = new Date(Date.now() + 60_000);

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => repo.claimOccurrence(schedule._id, occurrence)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('refuses an occurrence already fired, however long afterwards', async () => {
    const schedule = await create();
    const occurrence = new Date(Date.now() + 60_000);

    expect(await repo.claimOccurrence(schedule._id, occurrence)).toBe(true);
    // A retry an hour later must not fire this occurrence again.
    expect(await repo.claimOccurrence(schedule._id, occurrence)).toBe(false);
  });

  it('refuses an occurrence EARLIER than one already fired', async () => {
    // Catch-up walks forward, but a clock skew or an out-of-order tick could
    // present an older one. Firing it would run this morning's job tonight.
    const schedule = await create();
    const later = new Date(Date.now() + 120_000);
    const earlier = new Date(Date.now() + 60_000);

    expect(await repo.claimOccurrence(schedule._id, later)).toBe(true);
    expect(await repo.claimOccurrence(schedule._id, earlier)).toBe(false);
  });

  it('still allows the next occurrence', async () => {
    const schedule = await create();
    expect(await repo.claimOccurrence(schedule._id, new Date(Date.now() + 60_000))).toBe(true);
    expect(await repo.claimOccurrence(schedule._id, new Date(Date.now() + 120_000))).toBe(true);
  });

  it('does not owe every occurrence since the epoch when newly created', async () => {
    // lastFiredFor starts at creation, not null. Null would make the catch-up
    // walk treat a brand new daily schedule as owing every 09:00 ever.
    const schedule = await create();
    expect(schedule.lastFiredFor).toBeInstanceOf(Date);
    expect(await repo.claimOccurrence(schedule._id, new Date(Date.now() - 86_400_000))).toBe(false);
  });

  it('disables itself after enough consecutive failures', async () => {
    // A schedule pointed at a deleted agent cannot be fixed by retrying, and
    // one retrying every minute for ever buries whatever else is wrong.
    const schedule = await create();

    for (let attempt = 0; attempt < FAILURE_LIMIT; attempt += 1) {
      await repo.recordFailure(schedule._id, 'no such agent');
    }

    const stored = await repo.findById(schedule._id);
    expect(stored?.enabled).toBe(false);
    expect(stored?.consecutiveFailures).toBe(FAILURE_LIMIT);
  });

  it('clears the failure count when resumed', async () => {
    // Otherwise a schedule disabled for hitting the limit is re-disabled by its
    // very next failure, and can never be given another chance.
    const schedule = await create();
    for (let attempt = 0; attempt < FAILURE_LIMIT; attempt += 1) {
      await repo.recordFailure(schedule._id, 'no such agent');
    }

    await repo.setEnabled(schedule._id, true);

    const stored = await repo.findById(schedule._id);
    expect(stored?.enabled).toBe(true);
    expect(stored?.consecutiveFailures).toBe(0);
  });

  it('a successful run clears the failure count', async () => {
    const schedule = await create();
    await repo.recordFailure(schedule._id, 'transient');
    await repo.recordRun(schedule._id, 'run_1');

    const stored = await repo.findById(schedule._id);
    expect(stored?.consecutiveFailures).toBe(0);
    expect(stored?.lastRunId).toBe('run_1');
  });

  it('the tick sees enabled schedules from every workspace but not disabled ones', async () => {
    const mine = await create();
    const theirs = await new ScheduleRepository(db, 'wks_other').create({
      name: 'Theirs', expression: '0 9 * * *', timeZone: 'UTC',
      agentId: 'agt_2', modelBindingId: 'mbd_2', prompt: 'x', createdBy: 'usr_2',
    });
    await repo.setEnabled(mine._id, false);

    const found = await enabledSchedules(db);
    const ids = found.map((s) => s._id);

    // The tick is cross-workspace by necessity; a disabled schedule is not its
    // business at all.
    expect(ids).toContain(theirs._id);
    expect(ids).not.toContain(mine._id);
  });

  it('keeps one workspace out of another workspace schedules', async () => {
    const schedule = await create();
    const other = new ScheduleRepository(db, 'wks_other');

    expect(await other.findById(schedule._id)).toBeNull();
    expect(await other.claimOccurrence(schedule._id, new Date(Date.now() + 60_000))).toBe(false);
  });
});
