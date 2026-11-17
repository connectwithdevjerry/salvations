/**
 * One answer's speech, streamed from Fish to the browser as it is made, so
 * Jarvis starts talking at Fish's first sound rather than its last. Takes the
 * ticket the answer came with; see `speechTicket`.
 */
import { errorResponse } from '@/lib/http';
import { env } from '@/lib/env';
import { fishSpeechStream, fishVoice, readSpeechTicket } from '@/lib/fish-voice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const text = readSpeechTicket(new URL(request.url).searchParams.get('t') ?? '', env().INTERNAL_HMAC_SECRET);
    if (text === undefined) return errorResponse(403, 'forbidden', 'That ticket is not valid, or has run out.');
    const voice = await fishVoice();
    if (voice === undefined) return errorResponse(503, 'unsupported', 'The demo has no Fish voice right now.');
    const fish = await fishSpeechStream(text, voice);
    if (fish === undefined) return errorResponse(502, 'provider_error', 'Fish could not say that.');
    return new Response(fish.body, {
      headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
