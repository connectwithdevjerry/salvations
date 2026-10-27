/**
 * The landing page's voice demo: a recording in, what was heard and Bee's
 * answer out. Public, so it is limited — see `runDemoTurn`.
 */
import { errorResponse, ok } from '@/lib/http';
import { db } from '@/lib/db';
import { DEMO_MAX_AUDIO_BYTES, demoAvailable, runDemoTurn, visitorKey } from '@/lib/demo-voice';

export const runtime = 'nodejs';

/** Whether the demo is on, so the page can say so before anyone presses the button. */
export async function GET(): Promise<Response> {
  try {
    const { db: database } = await db();
    return ok({ available: await demoAvailable(database) });
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
      if (outcome.detail !== undefined) console.error('[demo-voice]', outcome.detail);
      return errorResponse(outcome.status, outcome.code, outcome.message);
    }
    return ok({ transcript: outcome.transcript, answer: outcome.answer });
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
