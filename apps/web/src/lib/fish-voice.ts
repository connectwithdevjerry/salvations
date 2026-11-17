/**
 * Jarvis's answers on the landing page, read aloud by Fish Audio.
 *
 * When the deployment holds a Fish key and a Fish voice (Deployment settings →
 * Landing page voice, or FISH_API_KEY and FISH_VOICE_ID), the console stops
 * using OpenAI's live call: OpenAI still hears the visitor and writes the
 * answer, and Fish speaks it in that voice. Without both, nothing changes.
 *
 * The answer comes back as text first, with a ticket; the browser then fetches
 * the speech with it and plays it as Fish makes it. Best effort by design: if
 * Fish refuses, the browser reads the answer out in its own voice.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { platformSettings } from './platform-settings';

const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
/** The one Fish model a key with no paid credit can use. */
export const FISH_DEFAULT_MODEL = 's2.1-pro-free';
const FISH_TIMEOUT_MS = 15_000;
const SPEECH_TICKET_MS = 60_000;

export interface FishVoice { readonly apiKey: string; readonly voiceId: string; readonly model: string }

/** The Fish voice the landing page speaks with, or undefined when it has none. */
export async function fishVoice(): Promise<FishVoice | undefined> {
  const [apiKey, voiceId, model] = await platformSettings(['landing_voice_fish_key', 'landing_voice_fish_voice', 'landing_voice_fish_model'] as const);
  if (apiKey === undefined || voiceId === undefined) return undefined;
  return { apiKey, voiceId, model: model ?? FISH_DEFAULT_MODEL };
}

/** The request Fish is sent, apart from the key. */
export function fishSpeechRequest(text: string, voice: FishVoice): { headers: Record<string, string>; body: Record<string, unknown> } {
  return {
    headers: { 'content-type': 'application/json', model: voice.model },
    body: { text, reference_id: voice.voiceId, format: 'mp3', mp3_bitrate: 64, latency: 'low', language: 'en' },
  };
}

/** Whether Fish accepts a key, asked of the cheapest endpoint that needs one. */
export async function verifyFishKey(apiKey: string): Promise<'ok' | 'rejected' | 'unreachable'> {
  try {
    const response = await fetch('https://api.fish.audio/wallet/self/api-credit', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return 'rejected';
    return response.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * The answer's speech, streamed: Fish's response, to be passed straight on to
 * the browser so it plays from the first sound rather than the last. Undefined
 * when Fish refuses, and the browser then reads the answer in its own voice.
 */
export async function fishSpeechStream(text: string, voice: FishVoice): Promise<Response | undefined> {
  const { headers, body } = fishSpeechRequest(text, voice);
  try {
    const response = await fetch(FISH_TTS_URL, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${voice.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FISH_TIMEOUT_MS),
    });
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '');
      console.error(JSON.stringify({ at: 'fish-voice', status: response.status, detail: detail.slice(0, 300) }));
      return undefined;
    }
    return response;
  } catch (caught) {
    console.error(JSON.stringify({ at: 'fish-voice', detail: caught instanceof Error ? caught.message : 'unknown error' }));
    return undefined;
  }
}

/**
 * A ticket for one answer's speech, good for a minute. The browser fetches the
 * audio with it after the answer arrives; it is signed, so only answers this
 * server wrote can be spoken, never any text a stranger sends.
 */
export function speechTicket(text: string, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ text, exp: now + SPEECH_TICKET_MS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The answer a ticket was issued for, or undefined when it is forged or stale. */
export function readSpeechTicket(ticket: string, secret: string, now = Date.now()): string | undefined {
  const [payload, signature, extra] = ticket.split('.');
  if (payload === undefined || signature === undefined || extra !== undefined) return undefined;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const { text, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { text?: unknown; exp?: unknown };
    if (typeof text !== 'string' || typeof exp !== 'number' || exp < now) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

const sign = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(`fish-speech:${payload}`).digest('base64url');
