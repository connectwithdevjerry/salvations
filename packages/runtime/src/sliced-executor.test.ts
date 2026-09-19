import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET, emptyConsumption, emptyUsage,
  type ClaimedRun, type Deadline, type LeaseToken, type ReleaseIntent, type Run, type RunId,
  type RunQueue, type RunStatus,
} from '@salvations/core';
import { WallClockDeadline, assertReserveFits } from './deadline';
import { SlicedExecutor, type ExecutionMetrics, type SlicedExecutorDeps } from './sliced-executor';
import type { AgentRuntime, ResolvedRun, StepOutcome } from './agent-runtime';

class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`Lease lost for run ${runId}.`);
    this.name = 'LeaseLostError';
  }
}

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1' as RunId,
  workspaceId: 'ws_1' as Run['workspaceId'],
  conversationId: 'cnv_1' as Run['conversationId'],
  agentId: 'agt_1' as Run['agentId'],
  agentVersionId: 'av_1' as Run['agentVersionId'],
  agentSnapshot: {
    systemPrompt: '', modelRole: 'chat', capabilityBindings: [],
    guardrails: { maxToolCallsPerTurn: 8 },
  },
  modelBindingId: 'mb_1' as Run['modelBindingId'],
  trigger: { type: 'user' },
  principal: {} as Run['principal'],
  status: 'queued',
  priority: 0,
  scheduledFor: new Date(0),
  attempts: 0,
  budget: DEFAULT_BUDGET,
  consumed: emptyConsumption,
  usage: emptyUsage,
  nextStepSeq: 0,
  depth: 0,
  queuedAt: new Date(0),
  ...over,
});

/**
 * An in-memory queue with REAL lease semantics.
 *
 * Every write is guarded by the token, exactly as MongoRunQueue's are, so a
 * stolen lease behaves here the way it does in production.
 */
class FakeQueue implements RunQueue {
  readonly releases: { runId: string; intent: ReleaseIntent }[] = [];
  #run: Run;
  #lease: { owner: string; token: string; until: number } | undefined;
  #now: () => number;

  constructor(initial: Run, now: () => number) {
    this.#run = initial;
    this.#now = now;
  }

  get state(): Run { return this.#run; }
  get leaseToken(): string | undefined { return this.#lease?.token; }

  expireLease(): void {
    if (this.#lease !== undefined) this.#lease = { ...this.#lease, until: this.#now() - 1 };
  }

  async enqueue(): Promise<void> {
    this.#run = { ...this.#run, status: 'queued' };
  }

  async claim(owner: string, leaseMs: number): Promise<ClaimedRun | null> {
    const held = this.#lease !== undefined && this.#lease.until > this.#now();
    if (this.#run.status !== 'queued' && !(this.#run.status === 'running' && !held)) return null;
    if (held) return null;

    const token = `lse_${Math.random().toString(36).slice(2)}`;
    const until = this.#now() + leaseMs;
    this.#lease = { owner, token, until };
    this.#run = { ...this.#run, status: 'running', attempts: this.#run.attempts + 1 };
    return {
      run: this.#run, leaseToken: token as LeaseToken, leaseUntil: new Date(until),
    };
  }

  async heartbeat(runId: RunId, token: LeaseToken, leaseMs: number): Promise<void> {
    if (this.#lease?.token !== token) throw new LeaseLostError(String(runId));
    this.#lease = { ...this.#lease, until: this.#now() + leaseMs };
  }

  async release(runId: RunId, token: LeaseToken, intent: ReleaseIntent): Promise<void> {
    if (this.#lease?.token !== token) throw new LeaseLostError(String(runId));
    this.releases.push({ runId: String(runId), intent });
    this.#lease = undefined;
    const status: RunStatus =
      intent.kind === 'requeue' ? 'queued'
      : intent.kind === 'suspend' ? intent.status
      : intent.status;
    this.#run = { ...this.#run, status };
  }

  async sweep(): Promise<number> { return 0; }
}

/** A runtime whose steps are scripted, and which records what it "did". */
function fakeRuntime(
  script: StepOutcome[],
  sideEffects: string[],
  onStep: () => void = () => undefined,
): AgentRuntime {
  const queue = [...script];
  return {
    stepOnce: async () => {
      const next = queue.shift() ?? { kind: 'finished', text: 'done' } as StepOutcome;
      // Steps take time. A slice must run out the way it does in production,
      // not start already expired.
      onStep();
      sideEffects.push(next.kind === 'continue' ? `step:${next.did}` : `step:${next.kind}`);
      return next;
    },
  } as unknown as AgentRuntime;
}

const CONTINUE: StepOutcome = { kind: 'continue', did: 'model_call' };
const FINISHED: StepOutcome = { kind: 'finished', text: 'all done' };

interface Harness {
  readonly executor: SlicedExecutor;
  readonly queue: FakeQueue;
  readonly effects: string[];
  readonly metrics: Recorded;
  advance(ms: number): void;
  /** A deadline sharing the harness clock, so time really passes. */
  deadline(sliceMs: number): Deadline;
}

interface Recorded extends ExecutionMetrics {
  readonly events: string[];
}

function metrics(): Recorded {
  const events: string[] = [];
  return {
    events,
    sliceYielded: (_id, steps) => events.push(`yielded:${steps}`),
    runFinished: (_id, status, steps) => events.push(`finished:${status}:${steps}`),
    runSuspended: (_id, reason) => events.push(`suspended:${reason}`),
    leaseLost: () => events.push('lease_lost'),
    idleWake: () => events.push('idle'),
    stepCompleted: (_id, did) => events.push(`step:${did}`),
  };
}

function harness(
  script: StepOutcome[],
  options: Partial<SlicedExecutorDeps> & { initial?: Run; stepCostMs?: number } = {},
): Harness {
  let clock = 1_000_000;
  const now = () => clock;
  const queue = new FakeQueue(options.initial ?? run(), now);
  const effects: string[] = [];
  const recorded = metrics();
  const stepCostMs = options.stepCostMs ?? 0;

  const executor = new SlicedExecutor({
    queue,
    openSession: async () => ({
      runtime: fakeRuntime(script, effects, () => { clock += stepCostMs; }),
      resolved: {} as ResolvedRun,
    }),
    metrics: recorded,
    now,
    reserveMs: 60_000,
    heartbeatEveryMs: 10,
    ...options,
  });

  return {
    executor, queue, effects, metrics: recorded,
    advance: (ms) => { clock += ms; },
    deadline: (sliceMs) => new WallClockDeadline(sliceMs, { now }),
  };
}

const RUN_ID = 'run_1' as RunId;

describe('driving a run to completion', () => {
  it('steps until the runtime says it is finished', async () => {
    const h = harness([CONTINUE, CONTINUE, FINISHED]);
    const outcome = await h.executor.execute(RUN_ID, h.deadline(300_000));

    // The run id is part of the outcome because the caller has to know WHICH
    // run finished: the queue hands out what most deserves to run, not the
    // hint, and a channel reply sent on the hint goes to the wrong person.
    expect(outcome).toEqual({ kind: 'finished', runId: RUN_ID, status: 'succeeded' });
    expect(h.effects).toHaveLength(3);
    expect(h.queue.state.status).toBe('succeeded');
  });

  it('names the run it actually drove, not the one it was asked about', async () => {
    /*
     * The hint is a wake-up, not an instruction: the queue hands out whatever
     * most deserves to run, which is frequently some other run that arrived
     * first. Everything downstream that acts on a finished run — carrying the
     * answer back to the chat it came from, above all — has to be told which
     * run that was.
     *
     * The other tests here cannot catch this, because in them the hinted run
     * and the claimed run are the same row, so an executor echoing the hint
     * passes every one of them.
     */
    const claimed = run({ id: 'run_claimed' as RunId });
    const h = harness([FINISHED], { initial: claimed });

    const outcome = await h.executor.execute('run_hinted' as RunId, h.deadline(300_000));

    expect(outcome).toEqual({ kind: 'finished', runId: 'run_claimed', status: 'succeeded' });
  });

  it('releases the lease exactly once', async () => {
    const h = harness([FINISHED]);
    await h.executor.execute(RUN_ID, h.deadline(300_000));
    expect(h.queue.releases).toHaveLength(1);
    expect(h.queue.leaseToken).toBeUndefined();
  });

  it('reports nothing to do as idle, not as a yield', async () => {
    // Reporting an empty wake-up as a yield schedules a continuation for work
    // that does not exist, and the two look identical in metrics.
    const h = harness([FINISHED], { initial: run({ status: 'succeeded' }) });
    expect(await h.executor.execute(RUN_ID, h.deadline(300_000))).toEqual({ kind: 'idle' });
    expect(h.metrics.events).toEqual(['idle']);
  });
});

describe('slicing', () => {
  // A slice that is long enough to start work and too short to finish it —
  // which is the only way a real slice ever runs out.
  const slicing = (script: StepOutcome[], over: Partial<SlicedExecutorDeps> = {}) =>
    harness(script, { reserveMs: 100_000, stepCostMs: 100_000, ...over });

  it('yields before the reserve rather than being killed mid-step', async () => {
    const h = slicing([CONTINUE, CONTINUE, CONTINUE, CONTINUE, FINISHED]);
    const outcome = await h.executor.execute(RUN_ID, h.deadline(250_000));

    expect(outcome.kind).toBe('yielded');
    // Two steps fitted; the third would have been started with no headroom to
    // persist it.
    expect(h.effects).toHaveLength(2);
  });

  it('puts the run back in queued so another slice can claim it', async () => {
    const h = slicing([CONTINUE, CONTINUE, CONTINUE]);
    await h.executor.execute(RUN_ID, h.deadline(250_000));

    expect(h.queue.state.status).toBe('queued');
    expect(h.queue.releases[0]?.intent).toMatchObject({ kind: 'requeue' });
  });

  it('asks for a continuation only after releasing the lease', async () => {
    // Triggering first would race the next slice against a lease this one
    // still holds.
    const order: string[] = [];
    const h = slicing([CONTINUE, CONTINUE, CONTINUE], {
      trigger: async () => { order.push('trigger'); },
    });
    const release = h.queue.release.bind(h.queue);
    h.queue.release = async (id, token, intent) => {
      order.push('release');
      return release(id, token, intent);
    };

    await h.executor.execute(RUN_ID, h.deadline(250_000));
    expect(order).toEqual(['release', 'trigger']);
  });

  it('does not lose the run when the continuation cannot be requested', async () => {
    // The run is already queued; the sweeper is exactly the second liveness
    // guarantee this case exists for.
    const h = slicing([CONTINUE, CONTINUE, CONTINUE], {
      trigger: async () => { throw new Error('the trigger endpoint is down'); },
    });
    const outcome = await h.executor.execute(RUN_ID, h.deadline(250_000));

    expect(outcome.kind).toBe('yielded');
    expect(h.queue.state.status).toBe('queued');
  });

  it('refuses a configuration whose reserve leaves no room to work', () => {
    // Otherwise the run bounces between queued and running forever while
    // looking busy.
    expect(() => assertReserveFits(30_000, 45_000)).toThrow(/never progress/);
    expect(() => assertReserveFits(300_000, 45_000)).not.toThrow();
  });
});

describe('suspension', () => {
  it('holds no lease while waiting for a person', async () => {
    const h = harness([{ kind: 'suspended', reason: 'approval', approvalId: 'apr_1' }]);
    const outcome = await h.executor.execute(RUN_ID, h.deadline(300_000));

    expect(outcome).toEqual({ kind: 'suspended', runId: RUN_ID, reason: 'approval' });
    expect(h.queue.state.status).toBe('waiting_approval');
    expect(h.queue.leaseToken).toBeUndefined();
  });

  it('maps each suspension reason to its own waiting status', async () => {
    for (const [reason, status] of [
      ['approval', 'waiting_approval'], ['input', 'waiting_input'], ['tool', 'waiting_tool'],
    ] as const) {
      const h = harness([{ kind: 'suspended', reason }]);
      await h.executor.execute(RUN_ID, h.deadline(300_000));
      expect(h.queue.state.status).toBe(status);
    }
  });
});

describe('a curtailed run', () => {
  it('records why it stopped rather than claiming a success it did not have', async () => {
    const h = harness([{
      kind: 'stopped', reason: 'budget', message: 'the cost budget was exhausted',
      text: 'partial answer',
    }]);
    const outcome = await h.executor.execute(RUN_ID, h.deadline(300_000));

    // The outcome carries the reason too, so the caller can say it out loud
    // without reading the run back.
    expect(outcome).toEqual({
      kind: 'finished', runId: RUN_ID, status: 'failed',
      error: { code: 'budget', message: 'the cost budget was exhausted' },
    });
    expect(h.queue.releases[0]?.intent).toMatchObject({
      kind: 'finish', status: 'failed', error: { code: 'budget' },
    });
  });

  it('finishes cleanly when a step throws, rather than leaving the run leased', async () => {
    const h = harness([]);
    const executor = new SlicedExecutor({
      queue: h.queue,
      openSession: async () => ({
        runtime: { stepOnce: async () => { throw new Error('a bug in a step'); } } as never,
        resolved: {} as ResolvedRun,
      }),
      reserveMs: 60_000,
      now: () => 1_000_000,
    });

    expect(await executor.execute(RUN_ID, new WallClockDeadline(300_000, { now: () => 1_000_000 })))
      .toMatchObject({ kind: 'finished', runId: RUN_ID, status: 'failed', error: { code: 'executor_error' } });
    expect(h.queue.leaseToken).toBeUndefined();
    expect(h.queue.releases[0]?.intent).toMatchObject({ error: { code: 'executor_error' } });
  });
});

describe('🔒 (AC-9) a stolen lease cannot cause a second side effect', () => {
  it('stops the moment the lease is gone, and does not release it', async () => {
    // Releasing would hand back a run this executor no longer holds — and the
    // new owner would find it queued while still running.
    let clock = 1_000_000;
    const queue = new FakeQueue(run(), () => clock);
    const effects: string[] = [];
    const recorded = metrics();

    const executor = new SlicedExecutor({
      queue,
      openSession: async () => ({
        // Each step takes time, so the heartbeat between steps actually comes
        // due — which is the mechanism under test.
        runtime: fakeRuntime([CONTINUE, CONTINUE, CONTINUE, FINISHED], effects, () => {
          clock += 5_000;
        }),
        resolved: {} as ResolvedRun,
      }),
      metrics: recorded,
      now: () => clock,
      reserveMs: 60_000,
      heartbeatEveryMs: 1_000,
    });

    const original = executor.execute(RUN_ID, new WallClockDeadline(300_000, { now: () => clock }));
    // The claim has been made by the time the executor first suspends; steal
    // the run out from under it.
    await Promise.resolve();
    queue.expireLease();
    await queue.claim('thief', 120_000);

    const outcome = await original;

    expect(outcome).toEqual({ kind: 'lease_lost' });
    // ONE step ran after the steal, not four: the heartbeat caught it on the
    // next time round the loop. Bounding the overlap to the step already in
    // flight is the whole guarantee.
    expect(effects).toHaveLength(1);
    expect(queue.releases).toEqual([]);
    expect(recorded.events).toContain('lease_lost');
  });

  it('runs to completion exactly once when a second executor takes over', async () => {
    let clock = 1_000_000;
    const queue = new FakeQueue(run(), () => clock);
    const effects: string[] = [];

    const build = () => new SlicedExecutor({
      queue,
      openSession: async () => ({
        runtime: fakeRuntime([CONTINUE, FINISHED], effects),
        resolved: {} as ResolvedRun,
      }),
      now: () => clock,
      reserveMs: 60_000,
      heartbeatEveryMs: 1,
    });

    const first = build().execute(RUN_ID, new WallClockDeadline(300_000, { now: () => clock }));
    clock += 10;
    queue.expireLease();
    const stolen = await queue.claim('second', 120_000);
    expect(await first).toEqual({ kind: 'lease_lost' });

    // The second executor, holding the live lease, carries the run home.
    expect(stolen).not.toBeNull();
    expect(queue.leaseToken).toBe(stolen?.leaseToken);

    await queue.release(RUN_ID, stolen?.leaseToken as LeaseToken, {
      kind: 'finish', status: 'succeeded',
    });

    // Exactly one terminal release, from the executor that actually held the lease.
    expect(queue.releases).toHaveLength(1);
    expect(queue.state.status).toBe('succeeded');
  });

  it('treats a lease-guarded write failing inside a step as a lease loss', async () => {
    // The step discovers it before the executor's next heartbeat does. Either
    // way the answer is the same: stop, write nothing more.
    const h = harness([]);
    const executor = new SlicedExecutor({
      queue: h.queue,
      openSession: async () => ({
        runtime: {
          stepOnce: async () => {
            const error = new Error('Lease lost for run run_1.');
            error.name = 'LeaseLostError';
            throw error;
          },
        } as never,
        resolved: {} as ResolvedRun,
      }),
      reserveMs: 60_000,
      now: () => 1_000_000,
    });

    expect(await executor.execute(RUN_ID, new WallClockDeadline(300_000, { now: () => 1_000_000 })))
      .toEqual({ kind: 'lease_lost' });
    expect(h.queue.releases).toEqual([]);
  });

  it('does not release when the lease was stolen just before the final write', async () => {
    const clock = 1_000_000;
    const queue = new FakeQueue(run(), () => clock);
    const executor = new SlicedExecutor({
      queue,
      openSession: async () => ({
        runtime: {
          stepOnce: async () => {
            // Simulates the lapse happening during the last step.
            queue.expireLease();
            await queue.claim('thief', 120_000);
            return FINISHED;
          },
        } as never,
        resolved: {} as ResolvedRun,
      }),
      reserveMs: 60_000,
      now: () => clock,
      heartbeatEveryMs: 1_000_000,
    });

    expect(await executor.execute(RUN_ID, new WallClockDeadline(300_000, { now: () => clock }))).toEqual({ kind: 'lease_lost' });
    expect(queue.state.status).toBe('running');
  });
});

describe('metrics', () => {
  it('reports the yield rate, which is how you learn slices are too short', async () => {
    const h = harness([CONTINUE, CONTINUE, CONTINUE], {
      reserveMs: 100_000, stepCostMs: 100_000,
    });
    await h.executor.execute(RUN_ID, h.deadline(250_000));
    expect(h.metrics.events).toContain('yielded:2');
  });

  it('reports each step, so a slow phase is visible without a profiler', async () => {
    const h = harness([CONTINUE, FINISHED]);
    await h.executor.execute(RUN_ID, h.deadline(300_000));
    expect(h.metrics.events).toEqual(['step:continue', 'step:finished', 'finished:succeeded:2']);
  });
});

describe('the deadline', () => {
  it('counts down against a wall clock', () => {
    let clock = 0;
    const d = new WallClockDeadline(1_000, { now: () => clock });
    expect(d.remainingMs()).toBe(1_000);
    clock += 400;
    expect(d.remainingMs()).toBe(600);
    expect(d.expired(500)).toBe(false);
    clock += 200;
    expect(d.expired(500)).toBe(true);
  });

  it('never reports negative time left', () => {
    let clock = 0;
    const d = new WallClockDeadline(100, { now: () => clock });
    clock += 5_000;
    expect(d.remainingMs()).toBe(0);
  });
});
