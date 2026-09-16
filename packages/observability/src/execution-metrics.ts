/**
 * The executor's metrics, expressed over the generic recorder.
 *
 * Kept here rather than in the runtime so the runtime depends on nothing but
 * core ports, and so an exporter can be swapped without touching execution.
 */
import type { MetricRecorder } from './metrics';

/** Mirrors `ExecutionMetrics` in the runtime, structurally. */
export class ExecutionMetricsRecorder {
  readonly #recorder: MetricRecorder;

  constructor(recorder: MetricRecorder) {
    this.#recorder = recorder;
  }

  sliceYielded(_runId: string, steps: number): void {
    this.#recorder.count('run.slice.yielded');
    // How much a slice actually achieved. A yield after zero steps means the
    // reserve is misconfigured, and it looks identical to a busy one in a count.
    this.#recorder.observe('run.slice.yielded', steps);
  }

  runFinished(_runId: string, status: string, steps: number): void {
    this.#recorder.count('run.finished', 1, { status });
    this.#recorder.observe('run.finished', steps, { status });
  }

  runSuspended(_runId: string, reason: string): void {
    this.#recorder.count('run.suspended', 1, { reason });
  }

  leaseLost(_runId: string): void {
    this.#recorder.count('run.lease_lost');
  }

  idleWake(): void {
    this.#recorder.count('executor.idle_wake');
  }

  stepCompleted(_runId: string, did: string, durationMs: number): void {
    this.#recorder.count('run.step', 1, { did });
    this.#recorder.observe('run.step', durationMs, { did });
  }
}
