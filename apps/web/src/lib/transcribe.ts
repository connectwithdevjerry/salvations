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
  | { readonly kind: 'failed'; readonly message: string; readonly detail?: string }
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
  const secret = providerRow.credentialId == null
    ? null
    : await credentials.resolve(providerRow.credentialId);

  const registry = providers();
  if (!registry.has(providerRow.providerType as never)) {
    return { kind: 'failed', message: 'No adapter is registered for that provider.' };
  }

  const provider = registry.create(
    providerRow.providerType as never,
    secret === null ? {} : { apiKey: secret.expose() },
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
    return { kind: 'failed', message: plainFailure(detail), detail };
  }
}

/** Said when nothing can hear: no OpenAI key, or a text-only model bound. */
export const NO_EAR = 'I can’t listen to voice notes yet: add an OpenAI key on the Models page and I will.';

/**
 * One sentence for the person, whatever the vendor said.
 *
 * A vendor's error carries a status code, a billing link and a sentence
 * written for a developer, none of which belongs in a chat with someone who
 * just spoke into their phone. Out of credit is the one cause they can fix
 * and is named; everything else is "try again", with the vendor's text kept
 * for the log.
 */
export function plainFailure(detail: string): string {
  if (/credit|billing|quota|insufficient_quota|\b429\b/i.test(detail)) {
    return 'Your OpenAI account is out of credit, so I can’t listen to voice notes until it is topped up.';
  }
  if (/401|invalid.?api.?key|incorrect api key|authentication/i.test(detail)) {
    return 'The OpenAI key on the Models page is not working, so I can’t listen to voice notes right now.';
  }
  return 'I couldn’t make out that voice note; could you send it again or type it?';
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
