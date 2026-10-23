/**
 * Where Slack delivers for every workspace that installed this deployment's
 * own app.
 *
 * One address for all of them, because Slack holds one request URL per app.
 * Set once, on the app, under Event Subscriptions and under Interactivity &
 * Shortcuts. The workspace id inside each delivery is what finds the
 * connection; nothing in the URL does, and nothing in the URL names a tenant.
 */
import { handleSharedDelivery } from '@/lib/channel-inbound';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  // Read as text, never as JSON: Slack signs the raw bytes.
  const raw = await request.text();
  const outcome = await handleSharedDelivery('slack', raw, request.headers);
  return new Response(outcome.body, { status: outcome.status, headers: { 'content-type': outcome.contentType } });
}

/** Slack verifies a request URL with a POSTed challenge, not a GET; a GET is somebody looking. */
export function GET(): Response {
  return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
}
