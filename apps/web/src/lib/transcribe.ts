/**
 * Turning a voice note into words.
 *
 * Goes through the same role → binding indirection as everything else: the
 * workspace binds a model to the `transcription` role, so which vendor hears
 * the audio is a configuration choice rather than something written into this
 * file. A workspace that has bound nothing gets a clear sentence back instead
 * of silence.
 *
 * The transcript is echoed to the person BEFORE the agent answers. That is not
 * decoration. Transcription is the one step in this whole system that can
 * silently replace what somebody said with something else, and the only person
 * who can catch it is the one who spoke. Showing it back costs a message and
 * makes the mistake visible at the moment it happens rather than three replies
 * later when the answer makes no sense.
 */
import { providerCredentials } from './platform-ai';
import { ModelBindingRepository, CredentialRepository } from '@salvations/db';
import type { Database } from '@salvations/db';
import type { InboundAudio } from '@salvations/channels';
import { providers, keyProvider } from './singletons';

/** The role a workspace binds to say which model hears its audio. */
export const TRANSCRIPTION_ROLE = 'transcription';

export type TranscriptionOutcome =
  | { readonly kind: 'transcribed'; readonly text: string }
  /**
   * Configured, attempted, and it did not work. `message` is the one plain
   * sentence to say to the person; `detail` is the vendor's own text, for the
   * log only, since it tends to carry links and status codes.
   */
  | { readonly kind: 'failed'; readonly message: string; readonly detail?: string; readonly reason?: FailureReason }
  /** Nothing is bound to the role. Not a failure — a deployment choice. */
  | { readonly kind: 'unconfigured' };

export async function transcribeAudio(
  database: Database,
  workspaceId: string,
  audio: InboundAudio,
  bytes: ArrayBuffer,
): Promise<TranscriptionOutcome> {
  const bindings = new ModelBindingRepository(database, workspaceId);
  const binding = await bindings.forRole(TRANSCRIPTION_ROLE);
  if (binding === null) return { kind: 'unconfigured' };

  const providerRow = await bindings.providerFor(binding);
  if (providerRow === null) return { kind: 'unconfigured' };

  const credentials = new CredentialRepository(database, workspaceId, keyProvider());

  const registry = providers();
  if (!registry.has(providerRow.providerType as never)) {
    return { kind: 'failed', message: 'No adapter is registered for that provider.' };
  }

  const provider = registry.create(
    providerRow.providerType as never,
    await providerCredentials(credentials, providerRow) ?? {},
  );

  // Optional on the port, because not every vendor can hear. Checked rather
  // than called-and-caught, so a workspace bound to a text-only provider gets
  // a sentence explaining that rather than a stack trace's worth of nothing.
  if (provider.transcribe === undefined) {
    return { kind: 'failed', message: NO_EAR, detail: 'The model bound for transcription cannot process audio.' };
  }

  try {
    const result = await provider.transcribe({
      modelId: binding.modelId,
      audio: bytes,
      mimeType: audio.mimeType,
      fileName: fileNameFor(audio.mimeType),
      // No language hint. None of these platforms tells us reliably, and a
      // wrong hint is worse than none.
    });

    const text = result.text.trim();
    if (text === '') {
      return { kind: 'failed', message: 'I could not hear anything in that recording.' };
    }
    return { kind: 'transcribed', text };
  } catch (caught) {
    // The adapter throws its own error shape, a plain object with the
    // vendor's sentence in `message`, not an Error. Read it either way: it
    // is the diagnosis, and it goes to the log. The person gets one sentence.
    const detail = caught instanceof Error
      ? caught.message
      : typeof caught === 'object' && caught !== null && typeof (caught as { message?: unknown }).message === 'string'
        ? (caught as { message: string }).message
        : 'unknown error';
    const code = vendorCode(caught);
    return { kind: 'failed', message: plainFailure(detail, code), detail, reason: failureReason(detail, code) };
  }
}

/** Said when nothing can hear: no OpenAI key, or a text-only model bound. */
export const NO_EAR = 'You can’t use voice notes here: the model this assistant can use does not support them.';

/** Why a transcription failed, as far as the person can act on it. */
export type FailureReason = 'out_of_credit' | 'rate_limited' | 'bad_key' | 'other';

/** The vendor's own error code (`insufficient_quota`, `rate_limit_exceeded`), when the adapter kept it. */
function vendorCode(caught: unknown): string | undefined {
  const raw = (caught as { providerRaw?: { code?: unknown; type?: unknown } } | undefined)?.providerRaw;
  const code = raw?.code ?? raw?.type;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Out of credit and rate-limited both arrive as a 429, and OpenAI's
 * rate-limit sentence ends by pointing at its billing page, so the word
 * "billing" proves nothing. The vendor's code decides where there is one;
 * otherwise the sentence's own words, the specific ones first.
 */
export function failureReason(detail: string, code?: string): FailureReason {
  if (code === 'insufficient_quota') return 'out_of_credit';
  if (code === 'rate_limit_exceeded') return 'rate_limited';
  if (/insufficient_quota|exceeded your current quota|no credits remaining|credit balance|out of credit/i.test(detail)) return 'out_of_credit';
  if (/rate.?limit|requests per min|tokens per min|\b(RPM|TPM)\b|too many requests/i.test(detail)) return 'rate_limited';
  if (/credit|billing|quota/i.test(detail)) return 'out_of_credit';
  if (/\b429\b/.test(detail)) return 'rate_limited';
  if (/401|invalid.?api.?key|incorrect api key|authentication/i.test(detail)) return 'bad_key';
  return 'other';
}

/**
 * One sentence for the person, whatever the vendor said.
 *
 * A vendor's error carries a status code, a billing link and a sentence
 * written for a developer, none of which belongs in a chat with someone who
 * just spoke into their phone. Out of credit is named, since it is the one
 * cause they can fix; a rate limit is a wait, not a bill; everything else is
 * "try again", with the vendor's text kept for the log.
 */
export function plainFailure(detail: string, code?: string): string {
  switch (failureReason(detail, code)) {
    case 'out_of_credit':
      return 'Your OpenAI account is out of credit, so I can’t listen to voice notes until it is topped up.';
    case 'rate_limited':
      return 'OpenAI is busy right now, so I couldn’t hear that voice note. Try again in a moment.';
    case 'bad_key':
      return 'The OpenAI key on the Models page is not working, so I can’t listen to voice notes right now.';
    default:
      return 'I couldn’t make out that voice note; could you send it again or type it?';
  }
}

/**
 * A filename for the audio.
 *
 * Several vendors infer the codec from the extension and ignore the declared
 * media type entirely, so this is load-bearing rather than cosmetic — the
 * failure without it is a 400 that names no field.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

export function fileNameFor(mimeType: string): string {
  // The parameters after a semicolon — `audio/ogg; codecs=opus` — are not part
  // of the type, and looking them up wholesale finds nothing.
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return `audio.${EXTENSIONS[base] ?? 'ogg'}`;
}
