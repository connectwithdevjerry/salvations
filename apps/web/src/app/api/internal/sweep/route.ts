/**
 * Stalled-lease sweeper.
 *
 * The safety net behind the push path: reclaims runs whose lease lapsed because
 * an executor died, a deploy interrupted it, or a continuation never fired.
 * Internal plumbing, not the user-facing scheduling feature — Phase 1 ships no
 * schedules collection and no cron UI.
 */
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from '@salvations/crypto';
import { MongoRunQueue } from '@salvations/db';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { VercelBackgroundTrigger } from '@/lib/trigger';

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
    await trigger.trigger(runId as never);
  }

  return Response.json({ ...swept, retriggered: orphaned.length }, { status: 200 });
}
