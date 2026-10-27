/**
 * The landing page's voice demo.
 *
 * A visitor who has not signed up yet presses the microphone, says something,
 * and hears Bee answer. It runs on the site owner's own OpenAI key, set on the
 * Admin page, so everything about it is shaped by the fact that a stranger is
 * spending somebody else's money:
 *
 *   - no tools, no workspace, no memory: a question in, a short answer out;
 *   - short recordings only, and a short answer;
 *   - a few turns per visitor per hour, and a ceiling for the whole site per
 *     day, both counted in the database so every instance shares them.
 *
 * Same pipeline as the Speak tab otherwise: the recording is transcribed
 * first and the transcript goes back with the answer, so the visitor sees
 * what was heard.
 */
import { createHash } from 'node:crypto';
import { DemoUsageRepository, type Database } from '@salvations/db';
import type { AgentProvider, GenerationRequest } from '@salvations/core';
import { providers } from './singletons';
import { platformSettings } from './platform';
import { fileNameFor, plainFailure } from './transcribe';

export const DEMO_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const DEMO_ANSWER_MODEL = 'gpt-4.1';

/** About twenty seconds of compressed speech. A question, not a monologue. */
export const DEMO_MAX_AUDIO_BYTES = 1024 * 1024;
export const DEMO_TURNS_PER_VISITOR_PER_HOUR = 8;
export const DEMO_TURNS_PER_DAY = 400;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const PERSONA = [
  'You are Bee, the voice of Salvations, speaking with a visitor on the landing page.',
  'Salvations gives a small business a team of AI assistants that work in the tools it already uses:',
  'Telegram, Discord, Slack, Gmail, Calendar, Drive and more. Each assistant has a job, remembers how',
  'the business likes things done, and asks before it does anything that changes something.',
  'People talk to it by text or by voice, on their own Claude or OpenAI key, with their data in their own database.',
  'This is a demo: you cannot see anyone\'s inbox, calendar or files, and you have no tools. If asked to do',
  'something real, say what the assistant would do once they sign up, in one sentence.',
  'Your answer is read aloud: two or three short sentences, plain spoken English, no lists, no markdown, no links.',
].join(' ');

export type DemoOutcome =
  | { readonly kind: 'answered'; readonly transcript: string; readonly answer: string }
  /** One plain sentence for the visitor; `status` is what the route answers with. */
  | { readonly kind: 'refused'; readonly status: number; readonly code: string; readonly message: string; readonly detail?: string };

/** Whether the site owner has set a key, so the page can say so before anyone speaks. */
export async function demoAvailable(database: Database): Promise<boolean> {
  return (await platformSettings(database).describeSecret('openai')) !== null;
}

/**
 * A visitor, as a counter key: a hash of their address, never the address.
 * Behind a proxy the first forwarded hop is the visitor.
 */
export function visitorKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const address = forwarded || request.headers.get('x-real-ip') || 'unknown';
  return createHash('sha256').update(address).digest('base64url').slice(0, 22);
}

export async function runDemoTurn(
  database: Database,
  visitor: string,
  audio: { readonly bytes: ArrayBuffer; readonly mimeType: string },
): Promise<DemoOutcome> {
  const secret = await platformSettings(database).resolveSecret('openai');
  if (secret === null) {
    return { kind: 'refused', status: 503, code: 'unsupported', message: 'The voice demo is switched off right now. Sign up to talk to your own assistant.' };
  }

  // Counted before anything is spent, visitor first: a visitor over their own
  // limit should not use up the site's.
  const usage = new DemoUsageRepository(database);
  if (!(await usage.take(`visitor:${visitor}`, DEMO_TURNS_PER_VISITOR_PER_HOUR, HOUR_MS))) {
    return { kind: 'refused', status: 429, code: 'budget_exhausted', message: 'That is all the demo has for you this hour. Sign up and keep talking to your own assistant.' };
  }
  if (!(await usage.take('site', DEMO_TURNS_PER_DAY, DAY_MS))) {
    return { kind: 'refused', status: 429, code: 'budget_exhausted', message: 'The demo has had a busy day and is resting. Try again tomorrow, or sign up.' };
  }

  const provider = providers().create('openai' as never, { apiKey: secret.expose() });
  try {
    if (provider.transcribe === undefined) throw new Error('This adapter cannot transcribe.');
    const heard = await provider.transcribe({
      modelId: DEMO_TRANSCRIBE_MODEL,
      audio: audio.bytes,
      mimeType: audio.mimeType,
      fileName: fileNameFor(audio.mimeType),
    });
    const transcript = heard.text.trim();
    if (transcript === '') {
      return { kind: 'refused', status: 422, code: 'validation_failed', message: 'I could not hear anything in that. Try again a little closer to the microphone.' };
    }
    const answer = await answerOf(provider, transcript);
    return { kind: 'answered', transcript, answer };
  } catch (caught) {
    const detail = caught instanceof Error
      ? caught.message
      : typeof caught === 'object' && caught !== null && typeof (caught as { message?: unknown }).message === 'string'
        ? (caught as { message: string }).message
        : 'unknown error';
    // The visitor is not the one who can top up the key, so the billing and
    // key sentences meant for an owner are not theirs to read.
    const owner = plainFailure(detail);
    const message = /OpenAI/.test(owner)
      ? 'The voice demo is unavailable right now. Sign up to talk to your own assistant.'
      : 'I could not make that out. Could you say it again?';
    return { kind: 'refused', status: 502, code: 'provider_error', message, detail };
  }
}

async function answerOf(provider: AgentProvider, said: string): Promise<string> {
  const request = {
    model: DEMO_ANSWER_MODEL,
    system: [{ kind: 'identity', text: PERSONA }],
    messages: [{ role: 'user', content: [{ type: 'text', text: said }] }],
    tools: [],
    toolChoice: 'none',
    maxOutputTokens: 220,
    metadata: { runId: 'demo', workspaceId: 'platform', agentId: 'bee-demo' },
  } as unknown as GenerationRequest;

  const signal = AbortSignal.timeout(25_000);
  let text = '';
  for await (const event of provider.generate(request, signal)) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'error') throw event.error;
  }
  const answer = text.trim();
  if (answer === '') throw new Error('The model returned no answer.');
  return answer;
}
