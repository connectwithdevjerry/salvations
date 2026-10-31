/**
 * The landing page's voice demo: a recording in, what was heard and Jarvis's
 * answer out. Public, so it is limited — see `runDemoTurn`.
 */
import { errorResponse, ok } from '@/lib/http';
import { db } from '@/lib/db';
import { DEMO_MAX_AUDIO_BYTES, demoKey, runDemoTurn, visitorKey } from '@/lib/demo-voice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Whether the demo runs on OpenAI, so the console knows which way to listen. */
export async function GET(): Promise<Response> {
  try {
    return ok({ available: (await demoKey()) !== undefined });
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const audio = form.get('audio');
    if (!(audio instanceof File) || audio.size === 0) {
      return errorResponse(422, 'validation_failed', 'Attach the recording as the "audio" field.');
    }
    if (audio.size > DEMO_MAX_AUDIO_BYTES) {
      return errorResponse(422, 'validation_failed', 'That was a bit long for the demo. Keep it to one short question.');
    }

    const { db: database } = await db();
    const outcome = await runDemoTurn(database, visitorKey(request), {
      bytes: await audio.arrayBuffer(),
      mimeType: audio.type === '' ? 'audio/webm' : audio.type,
    });
    if (outcome.kind === 'refused') {
      if (outcome.detail !== undefined) console.error(JSON.stringify({ at: 'demo-voice', detail: outcome.detail }));
      return errorResponse(outcome.status, outcome.code, outcome.message);
    }
    return ok({ transcript: outcome.transcript, answer: outcome.answer });
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
