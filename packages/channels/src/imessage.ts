/**
 * iMessage, through the person's own Mac.
 *
 * Apple offers no API for iMessage. Every hosted route to it is a company
 * holding the messages on the person's behalf, which this product refuses
 * to do. The one route that keeps the messages on the person's own
 * hardware is a Mac that stays signed in to Messages and runs the open
 * source BlueBubbles server, which exposes Messages over HTTP and posts
 * each new message to a URL. This adapter speaks to that server and to
 * nothing else; the Mac is the person's, the password is the person's,
 * and the messages never leave Apple's network and that Mac.
 *
 * The stored token is `<server address> <password>`: a URL cannot hold a
 * space, so the first one is the seam.
 *
 * What the Mac cannot do shapes the rest. It cannot sign a delivery, so a
 * delivery is believed only once the Mac has been asked whether the
 * message exists (`confirm`). It cannot edit a sent message, so there is
 * no draft. It has no buttons, so a question is asked in words.
 */
import { randomUUID } from 'node:crypto';
import { ChannelError, type ChannelAdapter, type ChannelIdentity, type InboundAudio, type InboundResult } from './port';
import { split } from './discord';
import { MAX_AUDIO_BYTES } from './telegram';

/** A sensible ceiling: Messages has none, but a wall of text is not a reply. */
export const MAX_MESSAGE_LENGTH = 4000;

/** The event the Mac is asked to post. */
export const NEW_MESSAGE_EVENT = 'new-message';

interface Envelope<T> { status?: number; message?: string; data?: T }

interface Parts { base: string; password: string }

function parts(token: string): Parts {
  const at = token.indexOf(' ');
  if (at <= 0) throw new ChannelError('imessage', 'This connection is missing the Mac\'s address. Reconnect iMessage.');
  const base = token.slice(0, at).replace(/\/+$/, '');
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
  } catch {
    throw new ChannelError('imessage', 'The server address should be a URL, like https://my-mac.example.com.');
  }
  return { base, password: token.slice(at + 1) };
}

/** The server's URL for a path, with the password where the server looks for it. */
function url(p: Parts, path: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams({ ...query, password: p.password });
  return `${p.base}/api/v1/${path}?${search.toString()}`;
}

async function call<T>(token: string, path: string, init: RequestInit, fetchImpl: typeof fetch, query?: Record<string, string>): Promise<T> {
  const p = parts(token);
  let response: Response;
  try {
    response = await fetchImpl(url(p, path, query), init);
  } catch (caught) {
    throw new ChannelError('imessage', `Could not reach your Mac: ${String(caught)}`);
  }
  const body = await response.json().catch(() => undefined) as Envelope<T> | undefined;
  if (!response.ok) {
    throw new ChannelError(
      'imessage',
      response.status === 401
        ? 'Your Mac rejected the password.'
        : `Your Mac refused the request (${response.status}). ${body?.message ?? ''}`.trim(),
      response.status,
    );
  }
  if (body?.data === undefined) throw new ChannelError('imessage', 'Your Mac answered with nothing.');
  return body.data;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

interface Attachment { guid?: string; mimeType?: string | null; totalBytes?: number; transferName?: string }
interface Message {
  guid?: string; text?: string | null; isFromMe?: boolean; dateCreated?: number;
  handle?: { address?: string } | null;
  chats?: { guid?: string; chatIdentifier?: string }[];
  attachments?: Attachment[];
}

/** The first voice memo or audio file on a message, as something to fetch later. */
function audioIn(attachments: readonly Attachment[] | undefined): InboundAudio | undefined {
  const file = attachments?.find((a) => typeof a.mimeType === 'string' && a.mimeType.startsWith('audio/') && a.guid !== undefined);
  if (file === undefined) return undefined;
  return {
    fileRef: file.guid as string,
    // The Mac converts Apple's own recording format to mp3 on download.
    mimeType: 'audio/mpeg',
    ...(file.totalBytes !== undefined ? { sizeBytes: file.totalBytes } : {}),
  };
}

export const imessageAdapter: ChannelAdapter = {
  channelId: 'imessage',

  tokenLabel: 'Server password',

  extraField: {
    label: 'Server address',
    help: 'The public address of the BlueBubbles server on your Mac, from its Connection page. The Cloudflare option there gives you one with nothing to configure.',
    placeholder: 'https://quiet-river-1234.trycloudflare.com',
  },

  composeToken: (token, extra) => `${extra.trim()} ${token.trim()}`,

  async identify(token, fetchImpl = globalThis.fetch): Promise<ChannelIdentity> {
    const info = await call<{ detected_imessage?: string; os_version?: string; server_version?: string; computer_id?: string }>(
      token, 'server/info', { method: 'GET' }, fetchImpl,
    );
    const account = info.detected_imessage !== undefined && info.detected_imessage !== '' ? info.detected_imessage : undefined;
    const host = new URL(parts(token).base).host;
    return {
      handle: account ?? host,
      displayName: account !== undefined ? `Messages, signed in as ${account}` : `Messages on ${host}`,
      botRef: account ?? host,
    };
  },

  /**
   * Tells the Mac where to post new messages. Repeating this adds nothing:
   * an address already registered is found first and left as it is.
   */
  async register(token, context, fetchImpl = globalThis.fetch): Promise<void> {
    const existing = await call<{ url?: string }[]>(token, 'webhook', { method: 'GET' }, fetchImpl);
    if (existing.some((w) => w.url === context.webhookUrl)) return;
    await call(token, 'webhook', json({ url: context.webhookUrl, events: [NEW_MESSAGE_EVENT] }), fetchImpl);
  },

  async unregister(token, fetchImpl = globalThis.fetch): Promise<void> {
    // Best effort, and only the hooks that are ours.
    const existing = await call<{ id?: number; url?: string }[]>(token, 'webhook', { method: 'GET' }, fetchImpl).catch(() => []);
    for (const hook of existing) {
      if (hook.id !== undefined && hook.url !== undefined && /\/api\/channels\/imessage\//.test(hook.url)) {
        await call(token, `webhook/${hook.id}`, { method: 'DELETE' }, fetchImpl).catch(() => undefined);
      }
    }
  },

  receive(raw): InboundResult {
    let event: { type?: string; data?: Message };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return { kind: 'rejected', reason: 'The delivery was not JSON.' };
    }
    if (event.type !== NEW_MESSAGE_EVENT) return { kind: 'ignored', reason: `A ${event.type ?? 'typeless'} event.` };
    const message = event.data;
    if (message === undefined || message.guid === undefined) return { kind: 'ignored', reason: 'An event with no message.' };
    // The Mac posts the assistant's own replies back as new messages too.
    if (message.isFromMe === true) return { kind: 'ignored', reason: 'Sent by this Mac.' };

    const chat = message.chats?.[0]?.guid;
    const from = message.handle?.address;
    if (chat === undefined || from === undefined) return { kind: 'ignored', reason: 'A message with no chat or sender.' };
    // One person, one chat. A group has many senders and is not a place to
    // run somebody's assistant from.
    if (/;\+;/.test(chat)) return { kind: 'ignored', reason: 'A group chat.' };

    const audio = audioIn(message.attachments);
    if (audio !== undefined && (audio.sizeBytes ?? 0) > MAX_AUDIO_BYTES) {
      return { kind: 'ignored', reason: 'A recording too large to fetch.' };
    }
    const text = (message.text ?? '').replace(/￼/g, '').trim();
    if (audio === undefined && text === '') return { kind: 'ignored', reason: 'No text.' };

    return {
      kind: 'message',
      message: {
        chatRef: chat, senderRef: from, senderLabel: from, text, messageRef: message.guid,
        ...(audio !== undefined ? { audio } : {}),
      },
    };
  },

  /**
   * The Mac cannot sign what it posts, so the message is looked up on the
   * Mac itself: it must exist, be from the person, and say what the
   * delivery said. A forged delivery would need a real message's guid and
   * words, and would then only repeat a message that was already answered.
   */
  async confirm(token, message, fetchImpl = globalThis.fetch): Promise<boolean> {
    try {
      const found = await call<Message>(token, `message/${encodeURIComponent(message.messageRef)}`, { method: 'GET' }, fetchImpl, { with: 'chats' });
      if (found.guid !== message.messageRef || found.isFromMe === true) return false;
      if (found.handle?.address !== message.senderRef) return false;
      const text = (found.text ?? '').replace(/￼/g, '').trim();
      return text === message.text || (message.audio !== undefined && text === '');
    } catch {
      return false;
    }
  },

  async send(token, chatRef, text, fetchImpl = globalThis.fetch): Promise<void> {
    for (const part of split(text, MAX_MESSAGE_LENGTH)) {
      await call(token, 'message/text', json({
        chatGuid: chatRef, tempGuid: randomUUID(), message: part, method: 'apple-script',
      }), fetchImpl);
    }
  },

  /** The picture or clip itself, uploaded from the link: Messages shows a file, not a preview card. */
  async sendMedia(token, chatRef, media, fetchImpl = globalThis.fetch): Promise<void> {
    const fetched = await fetchImpl(media.url);
    if (!fetched.ok) throw new ChannelError('imessage', `Could not fetch the ${media.kind} to send (${fetched.status}).`, fetched.status);
    const bytes = await fetched.arrayBuffer();
    const name = media.kind === 'video' ? 'clip.mp4' : 'picture.png';
    const form = new FormData();
    form.append('chatGuid', chatRef);
    form.append('tempGuid', randomUUID());
    form.append('name', name);
    form.append('method', 'apple-script');
    form.append('attachment', new Blob([bytes], { type: fetched.headers.get('content-type') ?? (media.kind === 'video' ? 'video/mp4' : 'image/png') }), name);
    await call(token, 'message/attachment', { method: 'POST', body: form }, fetchImpl);
    if (media.caption !== undefined && media.caption.trim() !== '') {
      await this.send(token, chatRef, media.caption, fetchImpl);
    }
  },

  /** "typing…" in the chat. Needs the Mac's private API; a Mac without it says so and the caller ignores it. */
  async indicate(token, chatRef, fetchImpl = globalThis.fetch): Promise<void> {
    await call(token, `chat/${encodeURIComponent(chatRef)}/typing`, { method: 'POST' }, fetchImpl);
  },

  /** The recording, converted by the Mac to mp3 on the way out. */
  async fetchAudio(token, audio, fetchImpl = globalThis.fetch): Promise<ArrayBuffer> {
    const p = parts(token);
    const response = await fetchImpl(url(p, `attachment/${encodeURIComponent(audio.fileRef)}/download`));
    if (!response.ok) {
      throw new ChannelError('imessage', `Your Mac would not serve that recording (${response.status}).`, response.status);
    }
    return await response.arrayBuffer();
  },
};
