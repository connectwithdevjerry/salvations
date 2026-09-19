/**
 * Delivering run events to a browser.
 *
 * The browser NEVER holds a connection to the function executing a run. It
 * tails the `runEvents` collection with a `seq` cursor, so a dropped connection
 * resumes exactly where it stopped, a page refresh replays nothing twice, and
 * the executor can die mid-answer without the reader noticing anything worse
 * than a pause.
 *
 * Two implementations, because one of them is not always available:
 *
 *   - `ChangeStreamEventBus` — a MongoDB change stream. Low latency, no
 *     polling. Requires a replica set: Atlas always has one, a bare `mongod`
 *     does not.
 *   - `PollingEventBus` — the fallback. Higher latency, works anywhere.
 *
 * Which one is in use is PROBED, not configured. A deployment that quietly
 * degraded to polling because a flag was wrong is a deployment whose latency
 * problem nobody can explain.
 */
import type { Db } from 'mongodb';
import type { RunEventDoc } from './documents';
import { PlatformDb } from './scoped';

export interface RunEventRecord {
  readonly runId: string;
  readonly workspaceId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

export interface RunEventReader {
  /**
   * Yields events after `afterSeq` until the signal aborts.
   *
   * Replays what already exists FIRST, then follows. A reader that subscribed
   * before replaying would miss everything written in between.
   */
  subscribe(
    runId: string,
    workspaceId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): AsyncIterable<RunEventRecord>;
}

const toRecord = (doc: RunEventDoc): RunEventRecord => ({
  runId: doc.runId,
  workspaceId: doc.workspaceId,
  seq: doc.seq,
  type: doc.type,
  payload: doc.payload,
  createdAt: doc.createdAt,
});

/**
 * Terminal events, after which no more will arrive.
 *
 * Without this a client waits out the full stream duration on a finished run,
 * holding a connection to learn nothing.
 */
const TERMINAL_EVENTS = new Set(['run_finished', 'run_suspended', 'run_yielded']);

export const isTerminalEvent = (type: string): boolean => TERMINAL_EVENTS.has(type);

/**
 * Does this deployment support change streams?
 *
 * Probed once per process by opening one and closing it. The failure is
 * distinctive and cheap, and the alternative — reading `hello.setName` — is a
 * proxy for the real question rather than the question itself.
 */
export async function supportsChangeStreams(db: Db): Promise<boolean> {
  try {
    const stream = db.collection('runEvents').watch([], { maxAwaitTimeMS: 100 });
    await stream.close();
    return true;
  } catch {
    return false;
  }
}

abstract class BaseEventBus implements RunEventReader {
  protected readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  protected collection() {
    // Reading events for a run the caller already proved it may read: the
    // workspace filter below is still applied, so this is a scoped read wearing
    // a platform-shaped hat rather than an unscoped one.
    return new PlatformDb(this.db, 'catalog-read').collection<RunEventDoc>('runEvents');
  }

  /** Everything already written. Always the first thing a subscriber sees. */
  protected async replay(
    runId: string,
    workspaceId: string,
    afterSeq: number,
  ): Promise<RunEventDoc[]> {
    return this.collection()
      .find(
        { runId, workspaceId, seq: { $gt: afterSeq } },
        { sort: { seq: 1 }, limit: 1_000 },
      )
      .toArray();
  }

  abstract subscribe(
    runId: string,
    workspaceId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): AsyncIterable<RunEventRecord>;
}

export class ChangeStreamEventBus extends BaseEventBus {
  async *subscribe(
    runId: string,
    workspaceId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): AsyncIterable<RunEventRecord> {
    // Opened BEFORE the replay, so an event written between the two is caught
    // by the stream rather than falling into the gap. Duplicates are filtered
    // by seq below; a gap could not be.
    const stream = this.collection().watch(
      [{ $match: { operationType: 'insert', 'fullDocument.workspaceId': workspaceId, 'fullDocument.runId': runId } }],
      { fullDocument: 'updateLookup' },
    );

    const abort = () => { void stream.close().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });

    let lastSeq = afterSeq;

    try {
      for (const doc of await this.replay(runId, workspaceId, afterSeq)) {
        lastSeq = doc.seq;
        yield toRecord(doc);
        if (isTerminalEvent(doc.type)) return;
      }

      for await (const change of stream) {
        if (signal.aborted) return;
        const doc = (change as { fullDocument?: RunEventDoc }).fullDocument;
        if (doc === undefined) continue;
        // The workspace check is not decoration: a change stream sees every
        // tenant's inserts, and the pipeline filter alone is one typo from
        // leaking them.
        if (doc.workspaceId !== workspaceId || doc.runId !== runId) continue;
        // Already replayed. This is why the stream may open first.
        if (doc.seq <= lastSeq) continue;

        lastSeq = doc.seq;
        yield toRecord(doc);
        if (isTerminalEvent(doc.type)) return;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await stream.close().catch(() => undefined);
    }
  }
}

export interface PollingOptions {
  readonly intervalMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

export class PollingEventBus extends BaseEventBus {
  readonly #intervalMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(db: Db, options: PollingOptions = {}) {
    super(db);
    // Short enough that a streamed answer does not feel batched, long enough
    // that a hundred idle readers are not a load problem on their own.
    this.#intervalMs = options.intervalMs ?? 400;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async *subscribe(
    runId: string,
    workspaceId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): AsyncIterable<RunEventRecord> {
    let lastSeq = afterSeq;

    while (!signal.aborted) {
      const docs = await this.replay(runId, workspaceId, lastSeq);
      for (const doc of docs) {
        lastSeq = doc.seq;
        yield toRecord(doc);
        if (isTerminalEvent(doc.type)) return;
      }
      if (signal.aborted) return;
      await this.#sleep(this.#intervalMs, signal);
    }
  }
}

/**
 * Picks an implementation by probing.
 *
 * Returns which one it chose, so a deployment can report it rather than leaving
 * an operator to infer a latency regression from graphs.
 */
export async function createEventBus(
  db: Db,
  options: PollingOptions = {},
): Promise<{ bus: RunEventReader; kind: 'change_stream' | 'polling' }> {
  return (await supportsChangeStreams(db))
    ? { bus: new ChangeStreamEventBus(db), kind: 'change_stream' }
    : { bus: new PollingEventBus(db, options), kind: 'polling' };
}
