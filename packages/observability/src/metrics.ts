/**
 * Execution metrics.
 *
 * Four numbers decide whether this deployment is healthy, and none of them is
 * obvious from a log line:
 *
 *   - SLICE YIELD RATE. A run that yields often is a run paying a cold start
 *     and a re-claim for every few steps. Rising yields mean slices are too
 *     short for the work, and it is cheaper to see that than to infer it from
 *     latency.
 *   - SWEEPER RECLAIMS. The sweeper is the safety net. Every reclaim is a push
 *     that did not arrive or a slice that died, so a non-zero rate is a signal
 *     even though nothing is broken.
 *   - LEASE LOSSES. Two executors briefly held one run. Rare is fine; rising
 *     means leases are shorter than steps.
 *   - COLD STARTS. The tax on a push-driven model, and the thing that makes a
 *     shorter slice worse than it looks.
 *
 * The recorder is an interface so the composition root can send these anywhere.
 * The in-memory one is for tests and for a single-process worker; it keeps no
 * history, so it cannot leak memory in a long-lived container.
 */

export type MetricName =
  | 'run.slice.yielded'
  | 'run.finished'
  | 'run.suspended'
  | 'run.step'
  | 'run.lease_lost'
  | 'executor.idle_wake'
  | 'executor.cold_start'
  | 'sweeper.reclaimed'
  | 'sweeper.failed'
  | 'sweeper.retriggered'
  | 'db.connection_opened';

export interface MetricRecorder {
  /** A count of something that happened. */
  count(name: MetricName, value?: number, tags?: Readonly<Record<string, string>>): void;
  /** A measurement, in milliseconds unless the name says otherwise. */
  observe(name: MetricName, value: number, tags?: Readonly<Record<string, string>>): void;
}

/** Discards everything. The default, so nothing has to guard on undefined. */
export const NO_METRICS: MetricRecorder = Object.freeze({
  count: () => undefined,
  observe: () => undefined,
});

interface Aggregate {
  count: number;
  sum: number;
  min: number;
  max: number;
}

const emptyAggregate = (): Aggregate =>
  ({ count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY });

/**
 * Aggregates in memory.
 *
 * Deliberately aggregates rather than retaining samples: a long-lived worker
 * would otherwise grow a list forever, and a metric that causes an outage is
 * not worth having.
 */
export class InMemoryMetrics implements MetricRecorder {
  readonly #counts = new Map<string, number>();
  readonly #observations = new Map<string, Aggregate>();

  #key(name: MetricName, tags?: Readonly<Record<string, string>>): string {
    if (tags === undefined) return name;
    const suffix = Object.entries(tags)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return suffix === '' ? name : `${name}{${suffix}}`;
  }

  count(name: MetricName, value = 1, tags?: Readonly<Record<string, string>>): void {
    const key = this.#key(name, tags);
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + value);
  }

  observe(name: MetricName, value: number, tags?: Readonly<Record<string, string>>): void {
    const key = this.#key(name, tags);
    const aggregate = this.#observations.get(key) ?? emptyAggregate();
    aggregate.count += 1;
    aggregate.sum += value;
    aggregate.min = Math.min(aggregate.min, value);
    aggregate.max = Math.max(aggregate.max, value);
    this.#observations.set(key, aggregate);
  }

  counts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.#counts);
  }

  observations(): Readonly<Record<string, { count: number; mean: number; min: number; max: number }>> {
    return Object.fromEntries(
      [...this.#observations].map(([key, a]) => [key, {
        count: a.count, mean: a.sum / a.count, min: a.min, max: a.max,
      }]),
    );
  }

  /**
   * Total for a metric across every tag combination.
   *
   * Reading the bare name would silently miss every tagged series — and since
   * finishes are tagged by status, a rate computed that way reports zero
   * forever and looks healthy while it does.
   */
  total(name: MetricName): number {
    let sum = 0;
    for (const [key, value] of this.#counts) {
      if (key === name || key.startsWith(`${name}{`)) sum += value;
    }
    return sum;
  }

  /**
   * Yields per completed run.
   *
   * The headline number for slice sizing: near zero means slices comfortably
   * fit a run; above one means every run is paying re-claims and cold starts.
   */
  yieldRate(): number {
    const finished = this.total('run.finished');
    return finished === 0 ? 0 : this.total('run.slice.yielded') / finished;
  }

  reset(): void {
    this.#counts.clear();
    this.#observations.clear();
  }
}
