/**
 * What every chat platform has to provide.
 *
 * Three platforms sit behind this, and they disagree about almost everything:
 * Telegram polls or pushes to a URL, Slack demands a signed handshake before it
 * will believe a URL exists, Discord wants a gateway socket or an interaction
 * endpoint. The port is the small set of things they do agree on — prove a
 * token works, turn a delivery into a message, send a reply — and every
 * disagreement is absorbed by an adapter rather than leaking upward.
 *
 * Nothing here knows what an agent is. An adapter's whole job is to turn a
 * platform's payload into `InboundMessage` and an answer back into an API call.
 */

/**
 * A voice note or audio file, not yet fetched.
 *
 * A reference rather than bytes, because deciding what to do with it is not
 * the adapter's business: whether this deployment can transcribe at all, and
 * whether the file is small enough to be worth downloading, are questions the
 * caller answers. An adapter that eagerly downloaded would spend bandwidth on
 * every voice note even where transcription is switched off.
 */
export interface InboundAudio {
  /** Opaque to everything but the adapter that produced it. */
  readonly fileRef: string;
  readonly mimeType: string;
  readonly durationSeconds?: number;
  readonly sizeBytes?: number;
}

/** A message that arrived from a person, normalised. */
export interface InboundMessage {
  /** The platform's own id for the chat, opaque to us. Routes the reply. */
  readonly chatRef: string;
  /** The platform's own id for the person. Identifies, never authorises. */
  readonly senderRef: string;
  /** How the sender is known on that platform, for display only. */
  readonly senderLabel: string;
  /**
   * What was typed. Empty when the message was purely a voice note — the text
   * then comes from transcribing `audio`.
   */
  readonly text: string;
  /** Present when the message was spoken rather than typed. */
  readonly audio?: InboundAudio;
  /** The platform's message id, used to drop a redelivery. */
  readonly messageRef: string;
}

/** The result of looking at an inbound HTTP request. */
export type InboundResult =
  | { readonly kind: 'message'; readonly message: InboundMessage }
  /**
   * Understood, but nothing to do — an edit, a reaction, a bot's own echo, or a
   * platform's liveness ping. Distinct from `rejected` because a platform that
   * gets an error for its own ping will disable the webhook.
   */
  | { readonly kind: 'ignored'; readonly reason: string }
  /** A challenge the platform expects answered verbatim before it trusts us. */
  | { readonly kind: 'challenge'; readonly body: string; readonly contentType: string }
  /** Not from the platform, or not provably so. */
  | { readonly kind: 'rejected'; readonly reason: string };

export interface ChannelIdentity {
  /** The bot's own handle, shown to the person setting it up. */
  readonly handle: string;
  /** The bot's display name on that platform. */
  readonly displayName: string;
  /** The platform's id for the bot itself, used to ignore its own messages. */
  readonly botRef: string;
}

export interface VerifyContext {
  /** Where this deployment receives deliveries for this connection. */
  readonly webhookUrl: string;
  /** A secret the platform echoes back, proving a delivery is ours. */
  readonly webhookSecret: string;
}

export interface ChannelAdapter {
  /** Matches an id in the catalogue. */
  readonly channelId: string;

  /**
   * A second secret the platform issues, when it has one.
   *
   * Telegram lets us choose the secret it echoes; Slack and Discord issue their
   * own and sign with it, so those two need a field on the form. Declaring it
   * here means the form is derived from the adapter rather than from a list
   * somebody has to remember to update.
   */
  readonly secondarySecret?: {
    readonly label: string;
    readonly help: string;
  };

  /**
   * Proves a token works and says whose it is.
   *
   * Called before anything is stored, so a typo fails at the form rather than
   * silently producing a connection that never delivers.
   */
  identify(token: string, fetchImpl?: typeof fetch): Promise<ChannelIdentity>;

  /**
   * Tells the platform where to deliver.
   *
   * Not every platform has one — Slack is configured in its own dashboard —
   * so an adapter may legitimately do nothing here.
   */
  register(token: string, context: VerifyContext, fetchImpl?: typeof fetch): Promise<void>;

  /** Undoes `register`. Best-effort: a revoked token cannot be unregistered. */
  unregister(token: string, fetchImpl?: typeof fetch): Promise<void>;

  /**
   * Decides what an inbound request is.
   *
   * Takes the raw body rather than parsed JSON because signature schemes sign
   * bytes, and re-serialising a parsed object does not reproduce them.
   *
   * Synchronous, deliberately. Every scheme here — an echoed secret, an HMAC,
   * an Ed25519 signature — is local arithmetic, and a signature check that can
   * await is a signature check that can hang the request it is protecting.
   */
  receive(raw: string, headers: Headers, context: VerifyContext): InboundResult;

  /** Sends a reply. Throws on refusal — a silent failure is a lost answer. */
  send(token: string, chatRef: string, text: string, fetchImpl?: typeof fetch): Promise<void>;

  /**
   * Fetches audio the adapter previously referenced.
   *
   * Absent on a platform whose files we cannot reach. Bytes, not a URL: on
   * every one of these platforms the file sits behind the bot's own
   * credentials, so a URL would either be useless to the transcription vendor
   * or would require handing that vendor the bot token.
   */
  fetchAudio?(
    token: string,
    audio: InboundAudio,
    fetchImpl?: typeof fetch,
  ): Promise<ArrayBuffer>;
}

/** A platform refused. Carries its own words, which are usually the diagnosis. */
export class ChannelError extends Error {
  readonly channelId: string;
  readonly status: number | undefined;

  constructor(channelId: string, message: string, status?: number) {
    super(message);
    this.name = 'ChannelError';
    this.channelId = channelId;
    this.status = status;
  }
}
