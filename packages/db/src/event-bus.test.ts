import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import type { RunEventDoc } from './documents';
import { PollingEventBus, isTerminalEvent } from './event-bus';

let seq = 0;
const event = (over: Partial<RunEventDoc> = {}): RunEventDoc => ({
  _id: `rev_${seq}`,
  workspaceId: 'ws_1',
  runId: 'run_1',
  seq: seq++,
  type: 'text_delta',
  payload: { text: 'x' },
  createdAt: new Date(0),
  ...over,
} as RunEventDoc);

/**
 * A database whose `runEvents` collection serves a growing array, so the
 * polling reader can be driven deterministically.
 */
function fakeDb(pages: RunEventDoc[][]): Db & { queries: unknown[] } {
  const queries: unknown[] = [];
  const remaining = [...pages];

  const collection = {
    find: (filter: unknown) => {
      queries.push(filter);
      const page = remaining.shift() ?? [];
      const afterSeq = (filter as { seq?: { $gt: number } }).seq?.$gt ?? -1;
      const workspaceId = (filter as { workspaceId?: string }).workspaceId;
      const runId = (filter as { runId?: string }).runId;
      return {
        toArray: async () =>
          page.filter((d) =>
            d.seq > afterSeq && d.workspaceId === workspaceId && d.runId === runId),
      };
    },
  };

  return { collection: () => collection, queries } as unknown as Db & { queries: unknown[] };
}

async function collect(
  iterable: AsyncIterable<{ seq: number; type: string }>,
  max = 50,
): Promise<{ seq: number; type: string }[]> {
  const out: { seq: number; type: string }[] = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

const never = new AbortController().signal;
const immediateSleep = async () => undefined;

describe('cursor replay', () => {
  it('replays everything already written before following', async () => {
    // A reader that subscribed before replaying would miss everything written
    // in between.
    seq = 0;
    const db = fakeDb([[event(), event(), event({ type: 'run_finished' })]]);
    const bus = new PollingEventBus(db, { sleep: immediateSleep });

    const events = await collect(bus.subscribe('run_1', 'ws_1', -1, never));
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('resumes after a cursor rather than repeating an answer', async () => {
    seq = 0;
    const all = [event(), event(), event(), event({ type: 'run_finished' })];
    const bus = new PollingEventBus(fakeDb([all]), { sleep: immediateSleep });

    const events = await collect(bus.subscribe('run_1', 'ws_1', 1, never));
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('follows across polls without repeating what it already yielded', async () => {
    seq = 0;
    const first = [event(), event()];
    const second = [...first, event(), event({ type: 'run_finished' })];
    const bus = new PollingEventBus(fakeDb([first, second]), { sleep: immediateSleep });

    const events = await collect(bus.subscribe('run_1', 'ws_1', -1, never));
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });
});

describe('scoping', () => {
  it('filters by workspace as well as run', async () => {
    // A run id is a guess away; the workspace is what actually confines a read.
    seq = 0;
    const mine = event();
    const theirs = event({ workspaceId: 'ws_2' });
    const done = event({ type: 'run_finished' });
    const bus = new PollingEventBus(fakeDb([[mine, theirs, done]]), { sleep: immediateSleep });

    const events = await collect(bus.subscribe('run_1', 'ws_1', -1, never));
    expect(events.map((e) => e.seq)).toEqual([mine.seq, done.seq]);
  });

  it('filters by run as well as workspace', async () => {
    seq = 0;
    const mine = event();
    const other = event({ runId: 'run_2' });
    const done = event({ type: 'run_finished' });
    const bus = new PollingEventBus(fakeDb([[mine, other, done]]), { sleep: immediateSleep });

    expect((await collect(bus.subscribe('run_1', 'ws_1', -1, never))).map((e) => e.seq))
      .toEqual([mine.seq, done.seq]);
  });
});

describe('ending the stream', () => {
  it('stops at a terminal event instead of holding the connection open', async () => {
    // Otherwise a client waits out the full stream duration on a finished run
    // to learn nothing.
    seq = 0;
    const docs = [event(), event({ type: 'run_finished' }), event()];
    const bus = new PollingEventBus(fakeDb([docs]), { sleep: immediateSleep });

    const events = await collect(bus.subscribe('run_1', 'ws_1', -1, never));
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'run_finished']);
  });

  it('treats a suspension as terminal too', async () => {
    // The run is waiting on a person; nothing more will arrive on this stream.
    expect(isTerminalEvent('run_suspended')).toBe(true);
    expect(isTerminalEvent('run_yielded')).toBe(true);
    expect(isTerminalEvent('run_finished')).toBe(true);
    expect(isTerminalEvent('text_delta')).toBe(false);
  });

  it('stops when the client goes away', async () => {
    seq = 0;
    const controller = new AbortController();
    const bus = new PollingEventBus(fakeDb([[event()], [event()]]), {
      sleep: async () => { controller.abort(); },
    });

    const events = await collect(bus.subscribe('run_1', 'ws_1', -1, controller.signal));
    expect(events).toHaveLength(1);
  });
});
