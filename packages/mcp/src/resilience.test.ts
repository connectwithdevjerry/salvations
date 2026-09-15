import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker, CircuitOpenError, Semaphore, ToolTimeoutError, withTimeout,
} from './resilience';

describe('Semaphore', () => {
  it('admits up to its permit count immediately', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);
  });

  it('queues beyond the limit and admits on release', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();

    let admitted = false;
    const second = sem.acquire().then((release) => { admitted = true; return release; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(sem.queued).toBe(1);

    first();
    await second;
    expect(admitted).toBe(true);
  });

  it('ignores a double release, which would inflate the permit count', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.available).toBe(1);
  });

  it('gives up waiting when the caller aborts', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const controller = new AbortController();
    const pending = sem.acquire(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/Aborted/);
    expect(sem.queued).toBe(0);
  });

  it('refuses an already-aborted caller without queueing', async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();
    await expect(sem.acquire(controller.signal)).rejects.toThrow(/Aborted/);
  });
});

describe('CircuitBreaker', () => {
  const at = (t: { now: number }) => new CircuitBreaker({
    failureThreshold: 3, openMs: 1000, now: () => t.now,
  });

  it('stays closed while calls succeed', () => {
    const t = { now: 0 };
    const breaker = at(t);
    for (let i = 0; i < 10; i++) {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.recordSuccess();
    }
    expect(breaker.state).toBe('closed');
  });

  it('opens after consecutive failures and refuses calls', () => {
    const t = { now: 0 };
    const breaker = at(t);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('resets its count on a success before the threshold', () => {
    const t = { now: 0 };
    const breaker = at(t);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
  });

  it('admits exactly one trial call when half-open', () => {
    // Admitting several would send a burst at a server that just came back,
    // which is how a recovering dependency gets knocked over again.
    const t = { now: 0 };
    const breaker = at(t);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    t.now = 1001;
    expect(breaker.state).toBe('half_open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('closes when the trial succeeds', () => {
    const t = { now: 0 };
    const breaker = at(t);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    t.now = 1001;
    breaker.tryAcquire();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.consecutiveFailures).toBe(0);
  });

  it('reopens immediately when the trial fails', () => {
    const t = { now: 0 };
    const breaker = at(t);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    t.now = 1001;
    breaker.tryAcquire();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    t.now = 1500;
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('carries the binding in its error', () => {
    expect(new CircuitOpenError('mcb_1', 5).message).toContain('mcb_1');
  });
});

describe('withTimeout', () => {
  it('returns a result that arrives in time', async () => {
    const result = await withTimeout(async () => 'ok', 1000, () => new Error('late'));
    expect(result).toBe('ok');
  });

  it('raises the supplied error when the operation overruns', async () => {
    await expect(
      withTimeout(
        (signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
        10,
        () => new ToolTimeoutError('gmail__send', 10),
      ),
    ).rejects.toThrow(ToolTimeoutError);
  });

  it('distinguishes the caller cancelling from the server being slow', async () => {
    // One is the server's fault and trips the circuit; the other is not.
    const outer = new AbortController();
    const pending = withTimeout(
      (signal) => new Promise((_r, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      10_000,
      () => new ToolTimeoutError('x', 10_000),
      outer.signal,
    );
    outer.abort();
    await expect(pending).rejects.not.toThrow(ToolTimeoutError);
  });
});
