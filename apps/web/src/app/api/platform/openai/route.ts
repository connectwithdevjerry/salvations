/**
 * The site owner's OpenAI key.
 *
 * What the landing page's voice demo runs on. Only the site's operators reach
 * this (PLATFORM_ADMIN_EMAILS); everyone else gets a 404. The key is checked
 * against OpenAI before it is kept, so a typo is caught here rather than by
 * the first visitor who speaks, and it is never sent back: the card sees the
 * last four characters and when it was set.
 */
import { z } from 'zod';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { platformRoute, platformSettings } from '@/lib/platform';
import { providers } from '@/lib/singletons';
import {
  DEMO_ANSWER_MODEL, DEMO_MAX_AUDIO_BYTES, DEMO_TRANSCRIBE_MODEL,
  DEMO_TURNS_PER_DAY, DEMO_TURNS_PER_VISITOR_PER_HOUR,
} from '@/lib/demo-voice';

export const runtime = 'nodejs';

const LIMITS = {
  transcribeModel: DEMO_TRANSCRIBE_MODEL,
  answerModel: DEMO_ANSWER_MODEL,
  turnsPerVisitorPerHour: DEMO_TURNS_PER_VISITOR_PER_HOUR,
  turnsPerDay: DEMO_TURNS_PER_DAY,
  maxAudioKb: Math.round(DEMO_MAX_AUDIO_BYTES / 1024),
};

export const GET = platformRoute(async ({ database }) => {
  const key = await platformSettings(database).describeSecret('openai');
  return ok({ key, limits: LIMITS });
});

const keySchema = z.object({ apiKey: z.string().trim().min(20, 'That does not look like an OpenAI key.').max(400) });

export const PUT = platformRoute(async ({ request, caller, database }) => {
  const { apiKey } = await jsonBody(request, keySchema);
  const check = await providers().create('openai' as never, { apiKey }).verify?.();
  if (check !== undefined && !check.ok) {
    return errorResponse(422, 'validation_failed', check.kind === 'rejected'
      ? 'OpenAI did not accept that key. Check it was copied whole.'
      : 'Could not reach OpenAI to check that key. Try again in a moment.');
  }
  const key = await platformSettings(database).setSecret('openai', apiKey, caller.email);
  return ok({ key, limits: LIMITS });
});

export const DELETE = platformRoute(async ({ database }) => {
  await platformSettings(database).clearSecret('openai');
  return ok({ key: null, limits: LIMITS });
});
