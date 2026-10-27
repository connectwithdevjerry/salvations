/**
 * Starting a live call with Bee on the landing page: a key good for one
 * minute to connect, and the model it is for. Public, so it is limited —
 * see `startLiveCall`.
 */
import { errorResponse } from '@/lib/http';
import { db } from '@/lib/db';
import { startLiveCall, visitorKey } from '@/lib/demo-voice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const { db: database } = await db();
    const outcome = await startLiveCall(database, visitorKey(request));
    if (outcome.kind === 'refused') {
      if (outcome.detail !== undefined) console.error(JSON.stringify({ at: 'demo-voice-live', detail: outcome.detail }));
      return errorResponse(outcome.status, outcome.code, outcome.message);
    }
    return Response.json(
      { clientSecret: outcome.clientSecret, model: outcome.model, maxSeconds: outcome.maxSeconds },
      // A key, however short-lived, is never cached anywhere.
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
