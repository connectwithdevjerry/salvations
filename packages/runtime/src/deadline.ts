/**
 * How much of this slice is left.
 *
 * Some environments cap how long a single invocation may run, and kill it at
 * the cap with no warning and no chance to persist. So the executor stops early
 * — `RESERVE_MS` before the wall — leaving enough time to finish the step in
 * flight, write it, emit its events and release the lease. A slice never ends
 * mid-step.
 *
 * The reserve is generous on purpose. Being killed mid-step costs a reclaim, a
 * duplicate attempt and possibly a repeated side effect; stopping early costs
 * one extra continuation. Which environment imposes the cap, and how long it
 * is, is configuration the runtime never sees.
 */
import { DEFAULT_RESERVE_MS, assertTimeoutBudget, type Deadline } from '@salvations/core';

// Re-exported so the executor's own module does not have to reach past it.
export { DEFAULT_RESERVE_MS };

export class WallClockDeadline implements Deadline {
  readonly #endsAt: number;
  readonly #now: () => number;

  constructor(totalMs: number, options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#endsAt = this.#now() + totalMs;
  }

  remainingMs(): number {
    return Math.max(0, this.#endsAt - this.#now());
  }

  expired(reserveMs: number): boolean {
    return this.remainingMs() <= reserveMs;
  }
}

/** A deadline that never expires — for a worker container, which has no slice. */
export const UNBOUNDED_DEADLINE: Deadline = Object.freeze({
  remainingMs: () => Number.POSITIVE_INFINITY,
  expired: () => false,
});

/**
 * Checks the whole timeout chain at composition time.
 *
 * A reserve larger than the slice means the executor yields before doing any
 * work, and the run bounces between `queued` and `running` forever while
 * looking busy. A tool ceiling above the reserve means the environment kills
 * the invocation before our own timeout fires. Both fail as intermittent
 * reclaims under load rather than as anything that points at the cause.
 */
export function assertReserveFits(sliceMs: number, reserveMs: number): void {
  assertTimeoutBudget(sliceMs, reserveMs);
}
