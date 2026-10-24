/**
 * Where Meta delivers for every WhatsApp number connected through this
 * deployment's own app: the app's one webhook callback URL, set under
 * WhatsApp → Configuration. The phone number id inside each delivery is
 * what finds the connection. Meta probes with a GET and a verify token
 * before it will save the address.
 */
import { handleSharedDelivery, handleSharedProbe } from '@/lib/channel-inbound';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  // Read as text, never as JSON: Meta signs the raw bytes.
  const raw = await request.text();
  const outcome = await handleSharedDelivery('whatsapp', raw, request.headers);
  return new Response(outcome.body, { status: outcome.status, headers: { 'content-type': outcome.contentType } });
}

export async function GET(request: Request): Promise<Response> {
  const outcome = await handleSharedProbe('whatsapp', new URL(request.url).searchParams);
  return new Response(outcome.body, { status: outcome.status, headers: { 'content-type': outcome.contentType } });
}
