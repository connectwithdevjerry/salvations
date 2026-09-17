/**
 * The sliced executor.
 *
 * It owns the loop the runtime deliberately does not: claim a run, step it
 * until the slice runs out, then persist, release the lease, put the run back
 * in `queued` and ask for a continuation.
 *
 * The runtime has no idea this exists. Swapping this for a `ContinuousExecutor`
 * in a worker container changes one binding at the composition root and not one
 * line of `stepOnce` — which is the entire reason the loop lives out here.
 *
 * Correctness rests on one rule: an executor that has lost its lease STOPS
 * IMMEDIATELY and writes nothing further. Atomic claiming alone is not enough —
 * a slow executor can still be mid-step when its lease lapses and another
 * executor picks the run up. Heartbeating before every step bounds the overlap
 * to the step already in flight, and the lease-guarded writes underneath make
 * the loser's writes no-ops.
 */
import type {
  Deadline, ExecOutcome, LeaseToken, Run, RunExecutor, RunId, RunQueue,
} from '@salvations/core';
import type { AgentRuntime, ResolvedRun, StepOutcome } from './agent-runtime';
import { DEFAULT_RESERVE_MS, assertReserveFits } from './deadline';

/** Raised by a lease-guarded write whose lease is gone. */
export const isLeaseLost = (error: unknown): boolean =>
  error instanceof Error && error.name === 'LeaseLostError';

export interface ExecutionSession {
  readonly runtime: AgentRuntime;
  readonly resolved: ResolvedRun;
}

/** What the executor needs, as narrow functions it cannot misuse. */
export interface SlicedExecutorDeps {
  readonly queue: RunQueue;
  /**
   * Builds the runtime and its resolved context for one claimed run.
   *
   * The lease token is passed in so the composition root can build a
   * lease-guarded store: every write the step makes then carries the token, and
   * a stolen lease turns them into no-ops rather than duplicate side effects.
   */
  openSession(run: Run, leaseToken: LeaseToken): Promise<ExecutionSession>;
  /** Wakes another slice. Absent means the sweeper is the only liveness path. */
  trigger?(runId: RunId): Promise<void>;
  readonly metrics?: ExecutionMetrics;
  readonly owner?: string;
  readonly leaseMs?: number;
  readonly reserveMs?: number;
  /** Re-checked before every step; also the lease-loss detector. */
  readonly heartbeatEveryMs?: number;
  readonly now?: () => number;
}

export interface ExecutionMetrics {
  /** A slice ended with work still to do. A high rate means slices are too short. */
  sliceYielded(runId: string, steps: number): void;
  runFinished(runId: string, status: string, steps: number): void;
  runSuspended(runId: string, reason: string): void;
  /** Never zero in a healthy system — but a rising count means leases are too short. */
  leaseLost(runId: string): void;
  idleWake(): void;
  stepCompleted(runId: string, did: string, durationMs: number): void;
}

const DEFAULTS = {
  leaseMs: 120_000,
  heartbeatEveryMs: 30_000,
} as const;

export class SlicedExecutor implements RunExecutor {
  readonly #deps: SlicedExecutorDeps;
  readonly #owner: string;
  readonly #leaseMs: number;
  readonly #reserveMs: number;
  readonly #heartbeatEveryMs: number;
  readonly #now: () => number;

  constructor(deps: SlicedExecutorDeps) {
    this.#deps = deps;
    this.#owner = deps.owner ?? `exec_${crypto.randomUUID()}`;
    this.#leaseMs = deps.leaseMs ?? DEFAULTS.leaseMs;
    this.#reserveMs = deps.reserveMs ?? DEFAULT_RESERVE_MS;
    this.#heartbeatEveryMs = deps.heartbeatEveryMs ?? DEFAULTS.heartbeatEveryMs;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Advances one run as far as this slice allows.
   *
   * `runId` is a WAKE-UP HINT, not a selector. The queue hands out whatever is
   * most deserving, which is usually the run just pushed and occasionally a
   * higher-priority one that arrived first. Nothing is lost either way: the
   * hinted run is still queued and the next push or sweep collects it. Honouring
   * the hint exactly would mean a second claim path and a fairness rule that
   * only applies to one of them.
   */
  async execute(runId: RunId, deadline: Deadline): Promise<ExecOutcome> {
    assertReserveFits(deadline.remainingMs(), this.#reserveMs);

    const claimed = await this.#deps.queue.claim(this.#owner, this.#leaseMs);
    if (claimed === null) {
      // Not an error and not a yield: the push raced a sweeper, or the run was
      // already finished by another slice.
      this.#deps.metrics?.idleWake();
      return { kind: 'idle' };
    }

    void runId;
    return this.#drive(claimed.run, claimed.leaseToken, deadline);
  }

  async #drive(run: Run, token: LeaseToken, deadline: Deadline): Promise<ExecOutcome> {
    const id = run.id;
    const session = await this.#deps.openSession(run, token);
    const signal = new AbortController().signal;

    let steps = 0;
    let lastHeartbeat = this.#now();

    for (;;) {
      // Checked BEFORE the step, never after: a step started with no headroom
      // is a step the platform kills halfway through.
      if (deadline.expired(this.#reserveMs)) {
        return this.#yield(id, token, steps);
      }

      if (this.#now() - lastHeartbeat >= this.#heartbeatEveryMs) {
        try {
          await this.#deps.queue.heartbeat(id, token, this.#leaseMs);
          lastHeartbeat = this.#now();
        } catch (error) {
          if (!isLeaseLost(error)) throw error;
          // Another executor owns this run. Stop here, write nothing, and do
          // NOT release — releasing would hand back a run we no longer hold.
          this.#deps.metrics?.leaseLost(String(id));
          return { kind: 'lease_lost' };
        }
      }

      const startedStep = this.#now();
      let step: StepOutcome;
      try {
        step = await session.runtime.stepOnce(session.resolved, signal);
      } catch (error) {
        if (isLeaseLost(error)) {
          // The step itself discovered it: a lease-guarded write refused.
          this.#deps.metrics?.leaseLost(String(id));
          return { kind: 'lease_lost' };
        }
        return this.#fail(id, token, error);
      }

      steps += 1;
      this.#deps.metrics?.stepCompleted(String(id), step.kind, this.#now() - startedStep);

      switch (step.kind) {
        case 'continue':
          continue;

        case 'finished':
          return this.#finish(id, token, 'succeeded', steps);

        case 'suspended':
          // A suspended run holds no lease, no process and no socket. It may
          // wait hours for a person and must cost nothing while it does.
          await this.#release(token, id, { kind: 'suspend', status: statusFor(step.reason) });
          this.#deps.metrics?.runSuspended(String(id), step.reason);
          return { kind: 'suspended', runId: id, reason: step.reason };

        case 'stopped':
          // Curtailed, not crashed. The partial answer is already persisted in
          // the conversation; the run records WHY it stopped rather than
          // claiming a success it did not have.
          return this.#finish(id, token, 'failed', steps, {
            code: step.reason, message: step.message,
          });
      }
    }
  }

  async #yield(runId: RunId, token: LeaseToken, steps: number): Promise<ExecOutcome> {
    const resumeAt = new Date(this.#now());
    try {
      await this.#deps.queue.release(runId, token, { kind: 'requeue', scheduledFor: resumeAt });
    } catch (error) {
      if (!isLeaseLost(error)) throw error;
      this.#deps.metrics?.leaseLost(String(runId));
      return { kind: 'lease_lost' };
    }

    this.#deps.metrics?.sliceYielded(String(runId), steps);
    // Requested AFTER the release, so the next slice finds a claimable run
    // rather than racing a lease this one still holds.
    await this.#triggerQuietly(runId);
    return { kind: 'yielded', resumeAt };
  }

  async #finish(
    runId: RunId,
    token: LeaseToken,
    status: 'succeeded' | 'failed',
    steps: number,
    error?: { code: string; message: string },
  ): Promise<ExecOutcome> {
    try {
      await this.#deps.queue.release(runId, token, {
        kind: 'finish', status, ...(error !== undefined ? { error } : {}),
      });
    } catch (released) {
      if (!isLeaseLost(released)) throw released;
      this.#deps.metrics?.leaseLost(String(runId));
      return { kind: 'lease_lost' };
    }
    this.#deps.metrics?.runFinished(String(runId), status, steps);
    return { kind: 'finished', runId, status };
  }

  async #fail(runId: RunId, token: LeaseToken, error: unknown): Promise<ExecOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    return this.#finish(runId, token, 'failed', 0, { code: 'executor_error', message });
  }

  async #release(
    token: LeaseToken,
    runId: RunId,
    intent: Parameters<RunQueue['release']>[2],
  ): Promise<void> {
    await this.#deps.queue.release(runId, token, intent);
  }

  /**
   * A continuation that cannot be requested is not fatal.
   *
   * The run is already back in `queued`, so the sweeper will collect it. Losing
   * the run to a failed push would be much worse than the latency.
   */
  async #triggerQuietly(runId: RunId): Promise<void> {
    try {
      await this.#deps.trigger?.(runId);
    } catch {
      // Deliberately swallowed. The sweeper is the second liveness guarantee,
      // and this is exactly the case it exists for.
    }
  }
}

const statusFor = (reason: 'approval' | 'input' | 'tool') =>
  reason === 'approval' ? 'waiting_approval' as const
  : reason === 'input' ? 'waiting_input' as const
  : 'waiting_tool' as const;
