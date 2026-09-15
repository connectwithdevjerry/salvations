/**
 * Execution ports.
 *
 * The runtime exposes a single step; an EXECUTOR owns the loop. That inversion
 * is the entire migration strategy: a serverless slice and a long-lived worker
 * differ only in how long they are willing to keep looping.
 */
import type { RunId, LeaseToken, WorkspaceId } from '../ids.js';
import type { Run, RunEvent, RunStatus } from '../entities/run.js';

/** Remaining wall clock for this execution slice. */
export interface Deadline {
  remainingMs(): number;
  /** True when finishing the current step would risk overrunning. */
  expired(reserveMs: number): boolean;
}

export type ExecOutcome =
  | { readonly kind: 'finished'; readonly status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'> }
  | { readonly kind: 'suspended'; readonly reason: 'approval' | 'input' | 'tool' }
  /** Slice exhausted. The run is back in `queued`, ready for continuation. */
  | { readonly kind: 'yielded'; readonly resumeAt: Date };

export interface RunExecutor {
  execute(runId: RunId, deadline: Deadline): Promise<ExecOutcome>;
}

export interface ClaimedRun {
  readonly run: Run;
  readonly leaseToken: LeaseToken;
  readonly leaseUntil: Date;
}

export type ReleaseIntent =
  | { readonly kind: 'requeue'; readonly scheduledFor: Date }
  | { readonly kind: 'suspend'; readonly status: Extract<RunStatus, 'waiting_approval' | 'waiting_input' | 'waiting_tool'> }
  | { readonly kind: 'finish'; readonly status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled' | 'expired'>;
      readonly error?: { readonly code: string; readonly message: string } };

/**
 * The queue.
 *
 * Phase 1 is backed by the `runs` collection itself via an atomic lease claim.
 * A later Redis implementation is a NOTIFICATION layer — the database stays the
 * source of truth, so a lost message costs latency, never correctness.
 */
export interface RunQueue {
  enqueue(runId: RunId, options?: { priority?: number; scheduledFor?: Date }): Promise<void>;
  claim(owner: string, leaseMs: number, workspaceIds?: readonly WorkspaceId[]): Promise<ClaimedRun | null>;
  /** Extends the lease. Fails if the lease was stolen — the caller must stop writing. */
  heartbeat(runId: RunId, token: LeaseToken, leaseMs: number): Promise<void>;
  release(runId: RunId, token: LeaseToken, intent: ReleaseIntent): Promise<void>;
  /** Reclaims runs whose lease expired. The safety net behind the push path. */
  sweep(now: Date, limit: number): Promise<number>;
}

/** Wakes an executor. The only port a deployment platform gets to influence. */
export interface BackgroundTrigger {
  trigger(runId: RunId): Promise<void>;
}

export interface RunEventBus {
  publish(event: RunEvent): Promise<void>;
  /** Replays from `afterSeq`, so a dropped connection resumes losslessly. */
  subscribe(runId: RunId, afterSeq: number, signal: AbortSignal): AsyncIterable<RunEvent>;
}
