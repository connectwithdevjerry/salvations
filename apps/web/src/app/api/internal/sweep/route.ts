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

export const runtime = 'nodejs';
export const maxDuration = 60;

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
  const swept = await new MongoRunQueue(handle.db).sweep();
  return Response.json(swept, { status: 200 });
}
