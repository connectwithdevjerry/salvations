/**
 * Saying something out loud.
 *
 * A recording from the browser, transcribed by the model the workspace bound
 * to the `transcription` role, then sent exactly as a typed message would be.
 * The transcript comes back in the answer so the person sees what was heard
 * before the assistant replies to it — transcription is the one step that can
 * silently replace what somebody said, and only the speaker can catch it.
 */
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { sendUserMessage } from '@/lib/send-message';
import { NO_EAR, transcribeAudio } from '@/lib/transcribe';

export const runtime = 'nodejs';

/** A minute of speech, generously. Longer is a monologue, not a message. */
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export const POST = workspaceRoute<{ conversationId: string }>('runs:create', async (ctx, params) => {
  const form = await ctx.request.formData();
  const audio = form.get('audio');
  if (!(audio instanceof File) || audio.size === 0) {
    return errorResponse(422, 'validation_failed', 'Attach the recording as the "audio" field.');
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return errorResponse(422, 'validation_failed', 'That recording is too long. Keep it under a minute or so.');
  }

  const mimeType = audio.type === '' ? 'audio/webm' : audio.type;
  const heard = await transcribeAudio(
    ctx.database,
    ctx.workspaceId,
    { fileRef: 'browser', mimeType, sizeBytes: audio.size },
    await audio.arrayBuffer(),
  );

  if (heard.kind === 'unconfigured') {
    return errorResponse(422, 'unsupported', NO_EAR);
  }
  if (heard.kind === 'failed') return errorResponse(502, 'provider_error', heard.message);

  const modelBindingId = form.get('modelBindingId');
  const outcome = await sendUserMessage(ctx, params.conversationId, {
    content: heard.text,
    ...(typeof modelBindingId === 'string' && modelBindingId !== '' ? { modelBindingId } : {}),
    idempotencyKey: crypto.randomUUID(),
  });

  return ok({ transcript: heard.text, ...outcome }, 202);
});
