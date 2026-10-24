/**
 * Where Discord delivers for every server that added this deployment's own
 * application: its one interactions endpoint, set on General Information.
 * The server id inside each interaction is what finds the connection.
 */
import { handleSharedDelivery } from '@/lib/channel-inbound';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  // Read as text, never as JSON: Discord signs the raw bytes.
  const raw = await request.text();
  const outcome = await handleSharedDelivery('discord', raw, request.headers);
  return new Response(outcome.body, { status: outcome.status, headers: { 'content-type': outcome.contentType } });
}

/** Discord verifies the endpoint with a signed POSTed ping; a GET is somebody looking. */
export function GET(): Response {
  return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
}
