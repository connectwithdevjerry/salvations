import { beforeEach, describe, expect, it } from 'vitest';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from '@salvations/crypto';
import type { RunId } from '@salvations/core';
import {
  DirectBackgroundTrigger, EXECUTE_PATH, VercelBackgroundTrigger, postInternal,
} from './trigger';

const SECRET = 'a'.repeat(48);

beforeEach(() => {
  process.env['MONGODB_URI'] = 'mongodb://localhost:27017';
  process.env['BETTER_AUTH_SECRET'] = 'b'.repeat(48);
  process.env['CREDENTIAL_KEK'] = 'c'.repeat(48);
  process.env['INTERNAL_HMAC_SECRET'] = SECRET;
  process.env['PUBLIC_BASE_URL'] = 'https://app.test';
});

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function capture(response: () => Response | Promise<Response> = () => new Response('', { status: 202 })) {
  const calls: Captured[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof globalThis.fetch;
  return { calls, fetchFn };
}

const RUN_ID = 'run_1' as RunId;

describe('the internal envelope', () => {
  it('signs the request, because a session cookie must never be enough', async () => {
    // /api/internal/execute drives arbitrary runs. Being signed in cannot be
    // sufficient to reach it.
    const { calls, fetchFn } = capture();
    await postInternal(EXECUTE_PATH, { runId: 'run_1' }, { fetch: fetchFn, secret: SECRET });

    const headers = calls[0]?.init.headers as Record<string, string>;
    const body = calls[0]?.init.body as string;

    expect(verify(SECRET, 'POST', EXECUTE_PATH, body, {
      signature: headers[SIGNATURE_HEADER] ?? null,
      timestamp: headers[TIMESTAMP_HEADER] ?? null,
    })).toEqual({ ok: true });
  });

  it('signs over the path and body, so neither can be swapped', async () => {
    const { calls, fetchFn } = capture();
    await postInternal(EXECUTE_PATH, { runId: 'run_1' }, { fetch: fetchFn, secret: SECRET });

    const headers = calls[0]?.init.headers as Record<string, string>;
    const signed = {
      signature: headers[SIGNATURE_HEADER] ?? null,
      timestamp: headers[TIMESTAMP_HEADER] ?? null,
    };

    expect(verify(SECRET, 'POST', '/api/internal/sweep', calls[0]?.init.body as string, signed).ok)
      .toBe(false);
    expect(verify(SECRET, 'POST', EXECUTE_PATH, '{"runId":"run_9"}', signed).ok).toBe(false);
  });

  it('posts to the configured public origin', async () => {
    const { calls, fetchFn } = capture();
    await postInternal(EXECUTE_PATH, {}, { fetch: fetchFn, secret: SECRET });
    expect(calls[0]?.url).toBe(`https://app.test${EXECUTE_PATH}`);
  });

  it('tolerates a base URL with a trailing slash', async () => {
    const { calls, fetchFn } = capture();
    await postInternal(EXECUTE_PATH, {}, {
      fetch: fetchFn, secret: SECRET, baseUrl: 'https://app.test/',
    });
    expect(calls[0]?.url).toBe(`https://app.test${EXECUTE_PATH}`);
  });
});

describe('waking an executor', () => {
  it('hands the dispatch to the platform rather than awaiting it', async () => {
    // waitUntil does not extend maxDuration; it only keeps the function from
    // exiting before the request is on the wire.
    const { calls, fetchFn } = capture();
    const backgrounded: Promise<unknown>[] = [];

    await new VercelBackgroundTrigger({
      fetch: fetchFn, secret: SECRET, background: (p) => { backgrounded.push(p); },
    }).trigger(RUN_ID);

    expect(backgrounded).toHaveLength(1);
    await Promise.all(backgrounded);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.body).toBe('{"runId":"run_1"}');
  });

  it('never throws when the wake-up fails', async () => {
    // The run is already queued; failing the caller would turn a latency
    // problem into a lost run.
    const backgrounded: Promise<unknown>[] = [];
    const trigger = new VercelBackgroundTrigger({
      fetch: (() => Promise.reject(new Error('DNS is down'))) as typeof globalThis.fetch,
      secret: SECRET,
      background: (p) => { backgrounded.push(p); },
    });

    await expect(trigger.trigger(RUN_ID)).resolves.toBeUndefined();
    await expect(Promise.all(backgrounded)).resolves.toBeDefined();
  });

  it('does not treat a non-2xx response as a failure worth raising', async () => {
    // The wake-up is advisory. Whether the receiving slice claimed anything is
    // its business, not the caller's.
    const { fetchFn } = capture(() => new Response('busy', { status: 503 }));
    await expect(
      new VercelBackgroundTrigger({ fetch: fetchFn, secret: SECRET, background: () => undefined })
        .trigger(RUN_ID),
    ).resolves.toBeUndefined();
  });

  it('awaits the dispatch where there is no platform hook', async () => {
    // A worker container or a local dev server: slower, and strictly more
    // predictable.
    const { calls, fetchFn } = capture();
    await new DirectBackgroundTrigger({ fetch: fetchFn, secret: SECRET }).trigger(RUN_ID);
    expect(calls).toHaveLength(1);
  });

  it('swallows a failed direct dispatch too', async () => {
    const trigger = new DirectBackgroundTrigger({
      fetch: (() => Promise.reject(new Error('unreachable'))) as typeof globalThis.fetch,
      secret: SECRET,
    });
    await expect(trigger.trigger(RUN_ID)).resolves.toBeUndefined();
  });
});
