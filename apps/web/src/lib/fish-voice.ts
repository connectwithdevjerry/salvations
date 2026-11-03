/**
 * Jarvis's answers on the landing page, read aloud by Fish Audio.
 *
 * When the deployment holds a Fish key and a Fish voice (Deployment settings →
 * Landing page voice, or FISH_API_KEY and FISH_VOICE_ID), the console stops
 * using OpenAI's live call: OpenAI still hears the visitor and writes the
 * answer, and Fish speaks it in that voice. Without both, nothing changes.
 *
 * Best effort by design: if Fish refuses or is slow, the answer still comes
 * back as text and the browser reads it out in its own voice.
 */
import { platformSettings } from './platform-settings';

const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
/** The one Fish model a key with no paid credit can use. */
export const FISH_DEFAULT_MODEL = 's2.1-pro-free';
const FISH_TIMEOUT_MS = 15_000;

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
    body: { text, reference_id: voice.voiceId, format: 'mp3', mp3_bitrate: 64, latency: 'balanced', language: 'en' },
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

/** The answer as speech, or undefined when Fish could not say it. Never throws. */
export async function fishSpeech(text: string, voice: FishVoice): Promise<{ readonly audio: string; readonly mimeType: string } | undefined> {
  const { headers, body } = fishSpeechRequest(text, voice);
  try {
    const response = await fetch(FISH_TTS_URL, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${voice.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FISH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(JSON.stringify({ at: 'fish-voice', status: response.status, detail: detail.slice(0, 300) }));
      return undefined;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) return undefined;
    return { audio: bytes.toString('base64'), mimeType: 'audio/mpeg' };
  } catch (caught) {
    console.error(JSON.stringify({ at: 'fish-voice', detail: caught instanceof Error ? caught.message : 'unknown error' }));
    return undefined;
  }
}
