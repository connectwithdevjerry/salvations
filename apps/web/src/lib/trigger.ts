/**
 * Waking an executor.
 *
 * The ONLY Vercel-aware adapter in the codebase. Everything above it sees the
 * `BackgroundTrigger` port, which is why moving execution to a worker container
 * later means replacing this one file rather than unpicking the runtime.
 *
 * Two verified constraints shape it:
 *
 * 1. `waitUntil` does NOT outlive `maxDuration`. There is no fire-and-forget on
 *    Vercel — work handed to it is still killed at the wall. So this only
 *    DISPATCHES a request; the receiving invocation gets its own full slice.
 *
 * 2. The self-call must be HMAC-signed. `/api/internal/execute` drives
 *    arbitrary runs, so a session cookie must never be enough to reach it.
 */
import { waitUntil } from '@vercel/functions';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from '@salvations/crypto';
import type { BackgroundTrigger, RunId } from '@salvations/core';
import { env } from './env';

export const EXECUTE_PATH = '/api/internal/execute';
export const SWEEP_PATH = '/api/internal/sweep';

export interface TriggerOptions {
  readonly baseUrl?: string;
  readonly secret?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Hands the dispatch to the platform so the caller can return immediately. */
  readonly background?: (promise: Promise<unknown>) => void;
}

/**
 * Signs and posts an internal request.
 *
 * Exported because the sweeper needs the same envelope, and two copies of a
 * signing routine is how one of them ends up subtly different.
 */
export async function postInternal(
  path: string,
  body: unknown,
  options: TriggerOptions = {},
): Promise<Response> {
  const configured = env();
  const baseUrl = (options.baseUrl ?? configured.PUBLIC_BASE_URL).replace(/\/$/, '');
  const payload = JSON.stringify(body ?? {});
  const headers = sign(options.secret ?? configured.INTERNAL_HMAC_SECRET, 'POST', path, payload);

  return (options.fetch ?? globalThis.fetch)(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: headers[SIGNATURE_HEADER],
      [TIMESTAMP_HEADER]: headers[TIMESTAMP_HEADER],
    },
    body: payload,
    // The response is never read: the point is to start another invocation,
    // not to wait for what it does.
    keepalive: true,
  });
}

export class VercelBackgroundTrigger implements BackgroundTrigger {
  readonly #options: TriggerOptions;

  constructor(options: TriggerOptions = {}) {
    this.#options = options;
  }

  /**
   * Asks for another slice.
   *
   * Never throws. A run that has been requeued is already safe — the sweeper is
   * the second liveness guarantee — and failing the caller because a wake-up
   * did not land would turn a latency problem into a lost run.
   */
  async trigger(runId: RunId): Promise<void> {
    const dispatch = postInternal(EXECUTE_PATH, { runId }, this.#options)
      .then(() => undefined)
      .catch(() => undefined);

    // Handed to the platform so the current response can return now. This does
    // NOT extend the current function's life — it only keeps it from exiting
    // before the request is on the wire.
    const background = this.#options.background ?? waitUntil;
    background(dispatch);
  }
}

/**
 * A trigger for environments with no platform hook — a worker container, a
 * test, or a local dev server.
 *
 * It awaits the dispatch rather than backgrounding it, which is slower and
 * strictly more predictable.
 */
export class DirectBackgroundTrigger implements BackgroundTrigger {
  readonly #options: TriggerOptions;

  constructor(options: TriggerOptions = {}) {
    this.#options = options;
  }

  async trigger(runId: RunId): Promise<void> {
    await postInternal(EXECUTE_PATH, { runId }, this.#options).catch(() => undefined);
  }
}
