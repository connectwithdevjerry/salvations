/**
 * WhatsApp, through Meta's Cloud API.
 *
 * The person brings their own Meta app and WhatsApp Business number: the
 * access token is theirs, the app secret is theirs, and every message goes
 * between their phone and Meta's API with nothing of ours in between. Two
 * ids and two secrets are involved, which is more than the other platforms
 * ask for, so they are named plainly here:
 *
 *   phone number id   which number the assistant answers from (not secret)
 *   access token      authorises calls to the API (secret; the "token")
 *   app secret        signs every delivery Meta makes (secret; the "secondary")
 *   verify token      what Meta echoes on its GET probe; derived from the
 *                     app secret so there is nothing extra to store
 *
 * The token stored is `<phone number id>:<access token>`, composed by this
 * adapter and split by it, so nothing above knows there were two parts.
 *
 * Meta's rules that shape this file: a reply is free-form only within 24
 * hours of the person's last message (every answer here is one, routines
 * aside); a sent message cannot be edited, so there is no draft and a
 * settled question is a new line; buttons are three at most with 20-char
 * labels; the typing indicator is tied to the message being answered.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ChannelError, type Ack, type ChannelAdapter, type ChannelIdentity, type Choice, type InboundAudio,
  type InboundResult, type VerifyContext,
} from './port';
import { split } from './discord';
import { MAX_AUDIO_BYTES } from './telegram';

export const GRAPH_VERSION = 'v22.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Meta's ceiling on one text body. */
export const MAX_MESSAGE_LENGTH = 4096;
/** And on a caption, a button label, a button id, and buttons per message. */
const MAX_CAPTION = 1024;
const MAX_BUTTON_LABEL = 20;
const MAX_BUTTON_ID = 256;
const MAX_BUTTONS = 3;

const SIGNATURE_HEADER = 'x-hub-signature-256';

/** Meta's media hosts, the only places the bearer token may be sent for a download. */
const MEDIA_HOSTS = ['.fbsbx.com', '.facebook.com', '.whatsapp.net'];

interface GraphError { error?: { message?: string; code?: number; error_subcode?: number } }

/** The error codes a person will actually meet, in words they can act on. */
const GRAPH_ERRORS: Readonly<Record<number, string>> = {
  190: 'Meta rejected the access token. It may have expired: make a permanent one from a system user.',
  131047: 'WhatsApp only lets me reply within 24 hours of your last message. Send me anything and I will answer.',
  131030: 'That number is not on this test number\'s recipient list. Add it under API Setup in your Meta app.',
  131026: 'WhatsApp says that number cannot receive messages.',
  131056: 'WhatsApp is pacing messages to that number. Try again in a moment.',
  100: 'Meta rejected the request as malformed. Check the phone number id.',
};

/** The two parts of the stored token. */
function parts(token: string): { phoneId: string; accessToken: string } {
  const at = token.indexOf(':');
  if (at <= 0) throw new ChannelError('whatsapp', 'This connection is missing its phone number id. Reconnect WhatsApp.');
  return { phoneId: token.slice(0, at), accessToken: token.slice(at + 1) };
}

async function call<T>(
  token: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<T> {
  const { accessToken } = parts(token);
  let response: Response;
  try {
    response = await fetchImpl(`${GRAPH}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  } catch (caught) {
    throw new ChannelError('whatsapp', `Could not reach Meta: ${String(caught)}`);
  }

  const body = await response.json().catch(() => undefined) as (T & GraphError) | undefined;
  if (!response.ok || body?.error !== undefined) {
    const code = body?.error?.code;
    const known = code !== undefined ? GRAPH_ERRORS[code] : undefined;
    throw new ChannelError(
      'whatsapp',
      known ?? `Meta refused the request (${response.status}). ${body?.error?.message ?? ''}`.trim(),
      response.status,
    );
  }
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** Every outbound message starts the same way. */
const envelope = (to: string): Record<string, unknown> => ({
  messaging_product: 'whatsapp', recipient_type: 'individual', to,
});

const sentId = (sent: { messages?: { id?: string }[] }): string => sent.messages?.[0]?.id ?? '';

/** The verify token is the app secret's child: nothing extra to store or remember. */
const verifyTokenOf = (context: VerifyContext): string =>
  createHmac('sha256', context.webhookSecret).update('hive-whatsapp-verify').digest('hex').slice(0, 32);

interface InboundValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: {
    from?: string; id?: string; timestamp?: string; type?: string;
    text?: { body?: string };
    audio?: { id?: string; mime_type?: string; voice?: boolean };
    interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
    button?: { payload?: string; text?: string };
    context?: { id?: string };
  }[];
  statuses?: unknown[];
}

export const whatsappAdapter: ChannelAdapter = {
  channelId: 'whatsapp',

  tokenLabel: 'Access token',

  extraField: {
    label: 'Phone number ID',
    help: 'Under WhatsApp → API Setup in your Meta app, beside the number the assistant will answer from. A number, not the phone number itself.',
    placeholder: '106540352242922',
  },

  secondarySecret: {
    label: 'App secret',
    help: 'Under App settings → Basic in your Meta app. Meta signs every delivery with it; without it nothing that arrives can be trusted.',
  },

  composeToken: (token, extra) => `${extra.trim()}:${token.trim()}`,

  async identify(token, fetchImpl = globalThis.fetch): Promise<ChannelIdentity> {
    const { phoneId } = parts(token);
    if (!/^\d{5,25}$/.test(phoneId)) {
      throw new ChannelError('whatsapp', 'The phone number id should be a number, the one Meta shows beside your phone number.');
    }
    const number = await call<{ display_phone_number?: string; verified_name?: string; id?: string }>(
      token, `/${phoneId}?fields=display_phone_number,verified_name`, { method: 'GET' }, fetchImpl,
    );
    const display = number.display_phone_number ?? phoneId;
    return {
      handle: display.startsWith('+') ? display : `+${display.replace(/\s/g, '')}`,
      displayName: number.verified_name ?? display,
      botRef: number.id ?? phoneId,
    };
  },

  // Meta's webhook is configured in the app dashboard: the callback URL and
  // the verify token we show. Nothing to register over the API.
  async register(): Promise<void> { /* configured in the Meta app dashboard */ },
  async unregister(): Promise<void> { /* configured in the Meta app dashboard */ },

  verifyToken: verifyTokenOf,

  verify(query, context): Ack | undefined {
    const mode = query.get('hub.mode');
    const presented = query.get('hub.verify_token');
    const challenge = query.get('hub.challenge');
    if (mode !== 'subscribe' || presented === null || challenge === null) return undefined;
    const expected = Buffer.from(verifyTokenOf(context));
    const given = Buffer.from(presented);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    return { body: challenge, contentType: 'text/plain' };
  },

  receive(raw, headers, context): InboundResult {
    const signature = headers.get(SIGNATURE_HEADER);
    if (signature === null || !signature.startsWith('sha256=')) {
      return { kind: 'rejected', reason: 'The delivery was not signed.' };
    }
    const expected = Buffer.from(createHmac('sha256', context.webhookSecret).update(raw).digest('hex'));
    const presented = Buffer.from(signature.slice('sha256='.length));
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      return { kind: 'rejected', reason: 'The signature did not verify.' };
    }

    let body: { object?: string; entry?: { changes?: { field?: string; value?: InboundValue }[] }[] };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return { kind: 'rejected', reason: 'The delivery was not JSON.' };
    }
    if (body.object !== 'whatsapp_business_account') return { kind: 'ignored', reason: 'Not a WhatsApp delivery.' };

    const value = body.entry?.flatMap((e) => e.changes ?? []).find((c) => c.field === 'messages')?.value;
    const message = value?.messages?.[0];
    if (value === undefined || message === undefined) {
      // Delivery receipts, read receipts and the like: ours, and nothing to do.
      return { kind: 'ignored', reason: 'A status update, not a message.' };
    }
    const from = message.from;
    const id = message.id;
    if (from === undefined || id === undefined) return { kind: 'ignored', reason: 'A message with no sender.' };
    const senderLabel = value.contacts?.find((c) => c.wa_id === from)?.profile?.name ?? `+${from}`;

    // A tap on one of our buttons. The id is ours; who tapped is theirs to
    // assert and the caller's to check.
    const tapped = message.type === 'interactive' && message.interactive?.type === 'button_reply'
      ? message.interactive.button_reply?.id
      : message.type === 'button' ? message.button?.payload : undefined;
    if (tapped !== undefined) {
      return {
        kind: 'choice',
        choice: {
          chatRef: from, senderRef: from, senderLabel, data: tapped,
          callbackRef: id,
          messageRef: message.context?.id ?? '',
          deliveryRef: `press:${id}`,
        },
      };
    }

    if (message.type === 'audio' && message.audio?.id !== undefined) {
      const audio: InboundAudio = { fileRef: message.audio.id, mimeType: message.audio.mime_type ?? 'audio/ogg' };
      return { kind: 'message', message: { chatRef: from, senderRef: from, senderLabel, text: '', audio, messageRef: id } };
    }

    if (message.type !== 'text' || message.text?.body === undefined || message.text.body.trim() === '') {
      return { kind: 'ignored', reason: `A ${message.type ?? 'typeless'} message, which has no words.` };
    }

    return { kind: 'message', message: { chatRef: from, senderRef: from, senderLabel, text: message.text.body, messageRef: id } };
  },

  async send(token, chatRef, text, fetchImpl = globalThis.fetch): Promise<void> {
    const { phoneId } = parts(token);
    for (const part of split(text, MAX_MESSAGE_LENGTH)) {
      await call(token, `/${phoneId}/messages`, post({
        ...envelope(chatRef), type: 'text', text: { body: part, preview_url: true },
      }), fetchImpl);
    }
  },

  async sendMedia(token, chatRef, media, fetchImpl = globalThis.fetch): Promise<void> {
    const { phoneId } = parts(token);
    const caption = media.caption !== undefined ? split(media.caption, MAX_CAPTION)[0] : undefined;
    await call(token, `/${phoneId}/messages`, post({
      ...envelope(chatRef),
      type: media.kind,
      [media.kind]: { link: media.url, ...(caption !== undefined ? { caption } : {}) },
    }), fetchImpl);
  },

  async sendChoices(token, chatRef, text, choices: readonly Choice[], fetchImpl = globalThis.fetch): Promise<string> {
    const { phoneId } = parts(token);
    const sent = await call<{ messages?: { id?: string }[] }>(token, `/${phoneId}/messages`, post({
      ...envelope(chatRef),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: split(text, MAX_CAPTION)[0] ?? text },
        action: {
          buttons: choices.slice(0, MAX_BUTTONS).map((c) => ({
            type: 'reply',
            reply: { id: c.data.slice(0, MAX_BUTTON_ID), title: c.label.slice(0, MAX_BUTTON_LABEL) },
          })),
        },
      },
    }), fetchImpl);
    return sentId(sent);
  },

  /**
   * Read, and "typing…" for up to 25 seconds. Meta ties the indicator to
   * the message being answered, so without that message's id there is
   * nothing to show, and the caller's later nudges do nothing.
   */
  async indicate(token, _chatRef, fetchImpl = globalThis.fetch, messageRef?: string): Promise<void> {
    if (messageRef === undefined) return;
    const { phoneId } = parts(token);
    await call(token, `/${phoneId}/messages`, post({
      messaging_product: 'whatsapp', status: 'read', message_id: messageRef, typing_indicator: { type: 'text' },
    }), fetchImpl);
  },

  /**
   * Two round trips, as Meta designed it: the media id resolves to a short-
   * lived URL, and the URL is fetched with the bearer token. The host is
   * checked to be Meta's before the token goes with it.
   */
  async fetchAudio(token, audio, fetchImpl = globalThis.fetch): Promise<ArrayBuffer> {
    const { accessToken } = parts(token);
    const media = await call<{ url?: string; mime_type?: string; file_size?: number | string }>(
      token, `/${audio.fileRef}`, { method: 'GET' }, fetchImpl,
    );
    if (media.url === undefined) throw new ChannelError('whatsapp', 'Meta would not say where that recording is.');
    if (Number(media.file_size ?? 0) > MAX_AUDIO_BYTES) throw new ChannelError('whatsapp', 'That recording is too large to fetch.');
    let host: string;
    try { host = new URL(media.url).host.toLowerCase(); } catch { host = ''; }
    if (!MEDIA_HOSTS.some((suffix) => host.endsWith(suffix))) {
      throw new ChannelError('whatsapp', 'That recording is not on Meta\'s servers.');
    }
    const response = await fetchImpl(media.url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw new ChannelError('whatsapp', `Meta would not serve that recording (${response.status}).`, response.status);
    }
    return await response.arrayBuffer();
  },
};

/** For tests and the setup screen: what the person pastes into Meta's dashboard. */
export const whatsappVerifyToken = verifyTokenOf;
