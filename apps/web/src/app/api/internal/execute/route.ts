/**
 * Run executor entrypoint.
 *
 * Reachable ONLY with a valid HMAC signature. This endpoint drives arbitrary
 * runs, so being signed in must never be sufficient to call it — a
 * cookie-authenticated executor would let any logged-in user execute anything.
 *
 * The runtime itself lands in §1.7; this establishes the guarded surface and
 * the slice deadline that the SlicedExecutor will run against.
 */
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from '@salvations/crypto';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

/**
 * Slice length.
 *
 * The hobby plan caps functions at 300s; this leaves headroom below that so the
 * executor can finish its current step, persist it, and release the lease
 * cleanly rather than being killed mid-step.
 */
export const maxDuration = 300;

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

  return Response.json({ status: 'accepted', note: 'executor lands in §1.7' }, { status: 202 });
}
