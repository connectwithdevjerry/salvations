/**
 * The landing page's voice demo, on OpenAI.
 *
 * A visitor who has not signed up yet presses Start, says something, and
 * hears Bee answer. It runs on the deployment's own OpenAI key: the one set
 * for it under Deployment settings → Landing page voice, or else Yashayah's
 * when Yashayah runs on OpenAI. A stranger is spending somebody else's money,
 * so everything about it is small:
 *
 *   - no tools, no workspace, no memory: a question in, a short answer out;
 *   - short recordings only, and a short answer;
 *   - a few turns per visitor per hour, and a ceiling for the whole site per
 *     day, counted in the database so every instance shares them.
 *
 * With no key at all the console keeps its scripted answers in the browser,
 * so the front page never offers a button that does nothing.
 */
import { createHash } from 'node:crypto';
import { DemoUsageRepository, type Database } from '@salvations/db';
import type { AgentProvider, GenerationRequest } from '@salvations/core';
import { providers } from './singletons';
import { platformSetting } from './platform-settings';
import { platformAi } from './platform-ai';
import { fileNameFor, plainFailure } from './transcribe';

export const DEMO_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const DEMO_ANSWER_MODEL = 'gpt-4.1';

/** About twenty seconds of compressed speech. A question, not a monologue. */
export const DEMO_MAX_AUDIO_BYTES = 1024 * 1024;
export const DEMO_TURNS_PER_VISITOR_PER_HOUR = 8;
export const DEMO_TURNS_PER_DAY = 400;

/**
 * The live call: OpenAI's Realtime model, speech to speech, the way ChatGPT's
 * voice works. Costlier than hearing-then-answering, so fewer and shorter:
 * the console hangs up at the time limit, and a visitor gets a few calls an
 * hour. The browser talks to OpenAI directly on a key that is only good for
 * a minute to start the call; the deployment's key never leaves the server.
 */
export const LIVE_DEFAULT_MODEL = 'gpt-realtime';
export const LIVE_DEFAULT_VOICE = 'marin';
export const LIVE_MAX_SECONDS = 90;
export const LIVE_CALLS_PER_VISITOR_PER_HOUR = 4;
export const LIVE_CALLS_PER_DAY = 150;
const LIVE_KEY_SECONDS = 60;
const REALTIME_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const PERSONA = [
  'You are Bee, the voice of YASHAYAH, speaking with a visitor on the landing page.',
  'YASHAYAH gives a small business a team of AI assistants that work in the tools it already uses:',
  'Telegram, WhatsApp, Slack, Gmail, Calendar, Drive, Instagram and more. Each assistant has a job, remembers how',
  'the business likes things done, and asks before it does anything that changes something.',
  'People talk to it by text or by voice, and their data stays in their own database.',
  'This is a demo: you cannot see anyone\'s inbox, calendar or files, and you have no tools. If asked to do',
  'something real, say in one sentence what the assistant would do once they sign up.',
  'Your answer is read aloud: two or three short sentences, plain spoken English, no lists, no markdown, no links.',
].join(' ');

export type DemoOutcome =
  | { readonly kind: 'answered'; readonly transcript: string; readonly answer: string }
  /** One plain sentence for the visitor; `status` is what the route answers with. */
  | { readonly kind: 'refused'; readonly status: number; readonly code: string; readonly message: string; readonly detail?: string };

/** The OpenAI key the demo runs on, or undefined when the deployment has none. */
export async function demoKey(): Promise<string | undefined> {
  const own = await platformSetting('landing_voice_openai_key');
  if (own !== undefined) return own;
  try {
    const hive = await platformAi();
    return hive !== undefined && hive.providerType === 'openai' && hive.baseUrl === undefined ? hive.apiKey : undefined;
  } catch {
    // A misconfigured Yashayah is reported where Yashayah is used; here it just means no key.
    return undefined;
  }
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
  const apiKey = await demoKey();
  if (apiKey === undefined) {
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

  const provider = providers().create('openai' as never, { apiKey });
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
    return { kind: 'answered', transcript, answer: await answerOf(provider, transcript) };
  } catch (caught) {
    const detail = caught instanceof Error
      ? caught.message
      : typeof caught === 'object' && caught !== null && typeof (caught as { message?: unknown }).message === 'string'
        ? (caught as { message: string }).message
        : 'unknown error';
    // The visitor cannot top up the key, so the billing and key sentences
    // meant for an owner are not theirs to read.
    const message = /OpenAI/.test(plainFailure(detail))
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

  let text = '';
  for await (const event of provider.generate(request, AbortSignal.timeout(25_000))) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'error') throw event.error;
  }
  const answer = text.trim();
  if (answer === '') throw new Error('The model returned no answer.');
  return answer;
}

export type LiveOutcome =
  | { readonly kind: 'ready'; readonly clientSecret: string; readonly model: string; readonly maxSeconds: number }
  | { readonly kind: 'refused'; readonly status: number; readonly code: string; readonly message: string; readonly detail?: string };

/** The spoken persona, for a conversation rather than one question. */
const LIVE_PERSONA = `${PERSONA} You are in a live voice conversation: keep each turn short, let the visitor interrupt, and ask one question back now and then about their business. The call ends by itself after ${LIVE_MAX_SECONDS} seconds; if it comes up, say they can keep talking to their own assistant once they sign up.`;

/**
 * Mints a short-lived key for one live call.
 *
 * Counted like a demo turn, but against its own smaller limits. The session
 * is configured here, not in the browser: the instructions, the voice, the
 * answer length and the model are fixed into the key, so a visitor holding
 * it cannot turn the call into something else.
 */
export async function startLiveCall(database: Database, visitor: string, fetchImpl: typeof fetch = fetch): Promise<LiveOutcome> {
  const apiKey = await demoKey();
  if (apiKey === undefined) {
    return { kind: 'refused', status: 503, code: 'unsupported', message: 'The voice demo is switched off right now. Sign up to talk to your own assistant.' };
  }
  const usage = new DemoUsageRepository(database);
  if (!(await usage.take(`live:${visitor}`, LIVE_CALLS_PER_VISITOR_PER_HOUR, HOUR_MS))) {
    return { kind: 'refused', status: 429, code: 'budget_exhausted', message: 'That is all the live calls the demo has for you this hour. Sign up and keep talking to your own assistant.' };
  }
  if (!(await usage.take('live:site', LIVE_CALLS_PER_DAY, DAY_MS))) {
    return { kind: 'refused', status: 429, code: 'budget_exhausted', message: 'The live demo has had a busy day and is resting. Try again tomorrow, or sign up.' };
  }

  const model = (await platformSetting('landing_voice_realtime_model')) ?? LIVE_DEFAULT_MODEL;
  const voice = (await platformSetting('landing_voice_voice')) ?? LIVE_DEFAULT_VOICE;
  let response: Response;
  try {
    response = await fetchImpl(REALTIME_SECRETS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        // Lets OpenAI tell one abusive visitor from the rest without being told who they are.
        'openai-safety-identifier': visitor,
      },
      body: JSON.stringify(liveSessionRequest(model, voice)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (caught) {
    return { kind: 'refused', status: 502, code: 'provider_error', message: 'Could not start a live call. Try again in a moment.', detail: caught instanceof Error ? caught.message : String(caught) };
  }
  const body = await response.json().catch(() => undefined) as { value?: unknown; client_secret?: { value?: unknown }; error?: { message?: string } } | undefined;
  // The key is `value` on the current API; an older shape nested it.
  const clientSecret = typeof body?.value === 'string' ? body.value
    : typeof body?.client_secret?.value === 'string' ? body.client_secret.value : undefined;
  if (!response.ok || clientSecret === undefined) {
    return {
      kind: 'refused', status: 502, code: 'provider_error',
      message: 'The live call is unavailable right now.',
      detail: `${response.status} ${body?.error?.message ?? 'no client secret in the answer'}`,
    };
  }
  return { kind: 'ready', clientSecret, model, maxSeconds: LIVE_MAX_SECONDS };
}

/** The session a live call's key is good for. Exported for the test that pins its shape. */
export function liveSessionRequest(model: string, voice: string): Record<string, unknown> {
  return {
    expires_after: { anchor: 'created_at', seconds: LIVE_KEY_SECONDS },
    session: {
      type: 'realtime',
      model,
      instructions: LIVE_PERSONA,
      max_output_tokens: 300,
      audio: {
        input: {
          // So the console can write down what the visitor said.
          transcription: { model: DEMO_TRANSCRIBE_MODEL },
          turn_detection: { type: 'semantic_vad' },
        },
        output: { voice },
      },
    },
  };
}
