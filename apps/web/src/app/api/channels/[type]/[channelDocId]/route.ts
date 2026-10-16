/**
 * Where chat platforms deliver.
 *
 * Deliberately outside the session-authenticated API. A platform has no cookie
 * and no API key — it authenticates by signing, and each adapter checks its own
 * platform's scheme before anything here acts on the body.
 *
 * The URL names a connection and not a workspace. A webhook URL ends up pasted
 * into somebody else's dashboard, quoted in a support thread and logged by a
 * proxy; putting a tenant id in it would publish the tenant boundary to all
 * three.
 */
import { handleDelivery, handleProbe } from '@/lib/channel-inbound';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ type: string; channelDocId: string }> },
): Promise<Response> {
  const { type, channelDocId } = await params;

  // Read as text, never as JSON: every signature scheme here signs bytes, and
  // re-serialising a parsed object does not reproduce them.
  const raw = await request.text();

  const outcome = await handleDelivery(type, channelDocId, raw, request.headers);

  return new Response(outcome.body, {
    status: outcome.status,
    headers: { 'content-type': outcome.contentType },
  });
}

/**
 * Some platforms probe with GET before they will save a URL.
 *
 * Meta expects its challenge echoed back once the verify token matches;
 * for the rest, 200 with nothing is enough, and strictly better than a 405
 * the dashboard reports as "endpoint unreachable".
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string; channelDocId: string }> },
): Promise<Response> {
  const { type, channelDocId } = await params;
  const outcome = await handleProbe(type, channelDocId, new URL(request.url).searchParams);
  return new Response(outcome.body, {
    status: outcome.status,
    headers: { 'content-type': outcome.contentType },
  });
}
