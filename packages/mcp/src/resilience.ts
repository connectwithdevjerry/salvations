/**
 * Concurrency limiting and circuit breaking for outbound MCP calls.
 *
 * An MCP server is third-party code reached over the network. Without limits, a
 * slow one consumes every execution slot the host has, and a failing one is
 * retried into the ground — so both are bounded here rather than at each call
 * site, where one forgotten guard undoes the rest.
 */

export class Semaphore {
  #available: number;
  readonly #waiters: (() => void)[] = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error('Semaphore needs at least one permit.');
    this.#available = permits;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw new Error('Aborted while waiting for a permit.');

    if (this.#available > 0) {
      this.#available -= 1;
      return this.#release();
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(wake);
        if (index !== -1) this.#waiters.splice(index, 1);
        reject(new Error('Aborted while waiting for a permit.'));
      };
      const wake = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.#waiters.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    return this.#release();
  }

  /** Released at most once, so a double-release cannot inflate the permit count. */
  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next !== undefined) next();
      else this.#available += 1;
    };
  }

  get available(): number {
    return this.#available;
  }

  get queued(): number {
    return this.#waiters.length;
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitOptions {
  readonly failureThreshold?: number;
  readonly openMs?: number;
  readonly now?: () => number;
}

/**
 * Stops hammering a server that is already failing.
 *
 * Half-open admits exactly ONE trial call. Admitting several would send a burst
 * at a server that has just come back, which is how a recovering dependency is
 * knocked over again.
 */
export class CircuitBreaker {
  #state: CircuitState = 'closed';
  #failures = 0;
  #openedAt = 0;
  #trialInFlight = false;
  readonly #threshold: number;
  readonly #openMs: number;
  readonly #now: () => number;

  constructor(options: CircuitOptions = {}) {
    this.#threshold = options.failureThreshold ?? 5;
    this.#openMs = options.openMs ?? 30_000;
    this.#now = options.now ?? (() => Date.now());
  }

  get state(): CircuitState {
    this.#refresh();
    return this.#state;
  }

  get consecutiveFailures(): number {
    return this.#failures;
  }

  #refresh(): void {
    if (this.#state === 'open' && this.#now() - this.#openedAt >= this.#openMs) {
      this.#state = 'half_open';
      this.#trialInFlight = false;
    }
  }

  /** Whether a call may proceed right now. */
  tryAcquire(): boolean {
    this.#refresh();
    if (this.#state === 'closed') return true;
    if (this.#state === 'open') return false;
    if (this.#trialInFlight) return false;
    this.#trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.#state = 'closed';
    this.#failures = 0;
    this.#trialInFlight = false;
  }

  recordFailure(): void {
    this.#failures += 1;
    this.#trialInFlight = false;
    // A failed trial reopens immediately rather than waiting for the threshold
    // again: the server just told us it is still broken.
    if (this.#state === 'half_open' || this.#failures >= this.#threshold) {
      this.#state = 'open';
      this.#openedAt = this.#now();
    }
  }

  reset(): void {
    this.#state = 'closed';
    this.#failures = 0;
    this.#trialInFlight = false;
  }
}

export class CircuitOpenError extends Error {
  readonly bindingId: string;
  constructor(bindingId: string, failures: number) {
    super(
      `MCP server for binding ${bindingId} is failing (${failures} consecutive errors); ` +
        'calls are paused until it recovers.',
    );
    this.name = 'CircuitOpenError';
    this.bindingId = bindingId;
  }
}

/**
 * Bounds how long a single tool call may take.
 *
 * MUST be shorter than the executor's slice reserve, or a slow server strands a
 * slice mid-step and the run is reclaimed with work half-done. Anything
 * genuinely long-running belongs in the Tasks extension, which suspends.
 */
export { DEFAULT_TOOL_TIMEOUT_MS } from '@salvations/core';

export class ToolTimeoutError extends Error {
  constructor(capabilityName: string, timeoutMs: number) {
    super(`Tool ${capabilityName} did not respond within ${timeoutMs}ms.`);
    this.name = 'ToolTimeoutError';
  }
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = (): void => controller.abort();
  outer?.addEventListener('abort', forward, { once: true });

  try {
    return await operation(controller.signal);
  } catch (error) {
    // Distinguish our deadline from the caller's cancellation: one is the
    // server's fault, the other is not, and they are handled differently.
    if (controller.signal.aborted && outer?.aborted !== true) throw onTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
}
