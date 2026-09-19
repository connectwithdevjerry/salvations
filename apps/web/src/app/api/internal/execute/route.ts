/**
 * Run executor entrypoint.
 *
 * Reachable ONLY with a valid HMAC signature. This endpoint drives arbitrary
 * runs, so being signed in must never be sufficient to call it — a
 * cookie-authenticated executor would let any logged-in user execute anything.
 *
 * It returns as soon as the slice ends, and the slice ends politely: the
 * executor stops `RESERVE_MS` before this function's own wall so it can finish
 * its step, persist it and release the lease rather than being killed mid-step.
 */
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from '@salvations/crypto';
import { WallClockDeadline, assertReserveFits, DEFAULT_RESERVE_MS } from '@salvations/runtime';
import { asId, type RunId } from '@salvations/core';
import { env } from '@/lib/env';
import { executor } from '@/lib/container';
import { deliverFinishedRun } from '@/lib/channel-delivery';

export const runtime = 'nodejs';

/**
 * Slice length.
 *
 * The hobby plan caps functions at 300s; this leaves headroom below that so the
 * executor can finish its current step, persist it, and release the lease
 * cleanly rather than being killed mid-step.
 */
export const maxDuration = 300;

/** Milliseconds of wall clock this invocation may use. */
const SLICE_MS = (maxDuration - 5) * 1_000;

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const url = new URL(request.url);

  const result = verify(
    env().INTERNAL_HMAC_SECRET,
    'POST',
    url.pathname,
    body,
    {
      signature: request.headers.get(SIGNATURE_HEADER),
      timestamp: request.headers.get(TIMESTAMP_HEADER),
    },
  );

  if (!result.ok) {
    // One opaque response for every failure mode: distinguishing a bad
    // signature from a stale timestamp helps only an attacker.
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Checked here rather than deeper: a reserve that does not fit the slice
  // makes every run bounce between queued and running while looking busy, and
  // the only place that knows the slice length is this file.
  assertReserveFits(SLICE_MS, DEFAULT_RESERVE_MS);

  const parsed = ((): { runId?: string } => {
    try { return JSON.parse(body) as { runId?: string }; } catch { return {}; }
  })();

  // The run id is a WAKE-UP HINT. The queue hands out whatever is most
  // deserving, which is usually this run and occasionally a higher-priority one
  // that arrived first; either way nothing is lost, because the hinted run stays
  // queued for the next push or sweep.
  const hint = asId<RunId>(parsed.runId ?? '');

  const outcome = await (await executor()).execute(
    hint, new WallClockDeadline(SLICE_MS),
  );

  // A run that came from a chat platform has to have its answer carried back.
  // Here, because this is the only moment anything knows the answer is
  // complete — and awaited rather than backgrounded, because `waitUntil` does
  // not outlive this function's wall and a backgrounded send would be killed
  // in transit.
  //
  // `outcome.runId` and not the hint: the queue hands out whatever most
  // deserves to run, which is usually but not always the run we were told
  // about. Using the hint would deliver one person's answer to another.
  const delivery = outcome.kind === 'finished'
    ? await deliverFinishedRun(String(outcome.runId))
    : undefined;

  // One line per slice, so the deployment's own logs say what happened to a
  // run without anyone reading the database. Ids and enum-shaped fields only.
  console.log(JSON.stringify({
    at: 'execute',
    hint: String(hint),
    ...outcome,
    ...(delivery !== undefined ? { delivery } : {}),
  }));

  // 202 throughout: this endpoint reports what the slice did, not whether the
  // run succeeded. A caller that treated `finished: failed` as an HTTP error
  // would retry a run that completed exactly as intended.
  return Response.json(outcome, { status: 202 });
}
