/**
 * Stalled-lease sweeper, and the schedule tick.
 *
 * Two jobs on one invocation, because both need to happen often, both are
 * signed the same way, and a second endpoint would be a second thing to
 * schedule, secure and watch for no gain.
 *
 * The sweeper reclaims runs whose lease lapsed — a dead executor, an
 * interrupted deploy, a continuation that never fired. The tick fires whatever
 * schedules are due. Neither can fail the other: the tick is awaited inside its
 * own try, because a broken schedule must never stop leases being reclaimed.
 */
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from '@salvations/crypto';
import { MongoRunQueue } from '@salvations/db';
import { asId, type RunId } from '@salvations/core';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { VercelBackgroundTrigger } from '@/lib/trigger';
import { tickSchedules } from '@/lib/schedule-tick';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * How long a `queued` run may sit before the sweeper assumes its push was lost.
 *
 * Generously longer than a normal claim: re-triggering a run that is about to
 * be claimed anyway is wasted work, and the claim is atomic so it is only
 * wasted, never harmful.
 */
const ORPHAN_AFTER_MS = 60_000;

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
  if (!result.ok) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return sweep();
}

/**
 * The platform's scheduler calls with a bearer it was given, not an HMAC it
 * cannot compute. Without CRON_SECRET set there is no schedule and this
 * answers 401 to everyone, so the endpoint is never open by accident.
 */
export async function GET(request: Request): Promise<Response> {
  const expected = env().CRON_SECRET;
  const presented = request.headers.get('authorization');
  if (expected === undefined || presented !== `Bearer ${expected}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return sweep();
}

async function sweep(): Promise<Response> {
  const handle = await db();
  const queue = new MongoRunQueue(handle.db);

  // 1. Reclaim runs whose lease lapsed — a crashed function, a killed slice, a
  //    deploy mid-step.
  const swept = await queue.sweep();

  // 2. Wake runs that are queued and overdue. A continuation that never fired
  //    leaves a run correct but idle, and only this notices.
  const orphaned = await queue.findOrphanedQueued(ORPHAN_AFTER_MS);
  const trigger = new VercelBackgroundTrigger();
  for (const runId of orphaned) {
    await trigger.trigger(asId<RunId>(runId));
  }

  // 3. Fire whatever schedules are due. Isolated, because a schedule pointed
  //    at a deleted agent must not stop leases being reclaimed.
  const schedules = await tickSchedules().catch((caught: unknown) => ({
    considered: 0,
    fired: 0,
    failed: 0,
    error: caught instanceof Error ? caught.message : String(caught),
  }));

  return Response.json(
    { ...swept, retriggered: orphaned.length, schedules },
    { status: 200 },
  );
}
