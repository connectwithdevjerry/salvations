/**
 * Where Telegram delivers for the deployment's shared bot: its one webhook,
 * pointed here by YASHAYAH itself. The chat id inside each update is what finds
 * the connection; a chat nobody has connected is bound by the code in its
 * first message.
 */
import { handleSharedDelivery } from '@/lib/channel-inbound';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  const outcome = await handleSharedDelivery('telegram', raw, request.headers);
  return new Response(outcome.body, { status: outcome.status, headers: { 'content-type': outcome.contentType } });
}

export function GET(): Response {
  return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
}
