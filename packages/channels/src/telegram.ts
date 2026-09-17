/**
 * Telegram.
 *
 * Telegram's Bot API is a plain HTTPS surface with the token in the path, which
 * is why the token never appears in a log line here: a URL that leaks is a bot
 * that is stolen.
 *
 * Deliveries are authenticated by a secret we choose and Telegram echoes in a
 * header. That is the whole of its authentication — there is no signature — so
 * the secret is generated per connection and compared in constant time.
 */
import { ChannelError, type ChannelAdapter, type ChannelIdentity, type InboundResult } from './port';
import { timingSafeEqualString } from './compare';

const API = 'https://api.telegram.org';

/** Telegram's own ceiling on one message. Longer answers are split, not cut. */
export const MAX_MESSAGE_LENGTH = 4096;

/** The header Telegram echoes our per-connection secret in. */
export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

interface TelegramResponse<T> { ok: boolean; result?: T; description?: string }

interface TelegramUser { id: number; is_bot: boolean; first_name?: string; username?: string }
interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat?: { id: number; type: string };
  text?: string;
}

async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (caught) {
    // A network failure and a refusal read very differently to someone setting
    // this up, so they are not collapsed into one message.
    throw new ChannelError('telegram', `Could not reach Telegram: ${String(caught)}`);
  }

  const parsed = await response.json().catch(() => undefined) as TelegramResponse<T> | undefined;
  if (parsed?.ok !== true || parsed.result === undefined) {
    // Telegram's own description is nearly always the actual diagnosis
    // ("Unauthorized", "chat not found"), so it is passed through rather than
    // replaced with something of our own invention.
    throw new ChannelError(
      'telegram',
      parsed?.description ?? `Telegram refused the request (${response.status}).`,
      response.status,
    );
  }
  return parsed.result;
}

/** Splits an answer at a line break where it can, and mid-text where it cannot. */
export function chunk(text: string, limit = MAX_MESSAGE_LENGTH): readonly string[] {
  if (text.length <= limit) return [text];

  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const breakAt = window.lastIndexOf('\n');
    // Only honour a line break in the last quarter. A break near the start
    // would emit a two-word message followed by a wall of text.
    const cut = breakAt > limit * 0.75 ? breakAt : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest !== '') parts.push(rest);
  return parts;
}

export const telegramAdapter: ChannelAdapter = {
  channelId: 'telegram',

  async identify(token, fetchImpl = globalThis.fetch): Promise<ChannelIdentity> {
    const me = await call<TelegramUser>(token, 'getMe', {}, fetchImpl);
    if (me.is_bot !== true) {
      throw new ChannelError('telegram', 'That token does not belong to a bot.');
    }
    return {
      handle: me.username === undefined ? String(me.id) : `@${me.username}`,
      displayName: me.first_name ?? me.username ?? 'Bot',
      botRef: String(me.id),
    };
  },

  async register(token, context, fetchImpl = globalThis.fetch): Promise<void> {
    await call(token, 'setWebhook', {
      url: context.webhookUrl,
      secret_token: context.webhookSecret,
      // Only what we act on. Asking for everything means paying to parse edits,
      // reactions and membership changes we immediately discard.
      allowed_updates: ['message'],
      // A bot token can only serve one webhook. Someone reconnecting after a
      // failed attempt should not be told the bot is busy with itself.
      drop_pending_updates: true,
    }, fetchImpl);
  },

  async unregister(token, fetchImpl = globalThis.fetch): Promise<void> {
    await call(token, 'deleteWebhook', {}, fetchImpl).catch(() => undefined);
  },

  receive(raw, headers, context): InboundResult {
    const presented = headers.get(SECRET_HEADER);
    if (presented === null || !timingSafeEqualString(presented, context.webhookSecret)) {
      return { kind: 'rejected', reason: 'The delivery did not carry this connection\'s secret.' };
    }

    let update: { message?: TelegramMessage };
    try {
      update = JSON.parse(raw) as { message?: TelegramMessage };
    } catch {
      return { kind: 'rejected', reason: 'The delivery was not JSON.' };
    }

    const message = update.message;
    if (message?.chat === undefined || message.from === undefined) {
      return { kind: 'ignored', reason: 'Not a chat message.' };
    }
    // A bot answering a bot is how a loop starts, and Telegram will happily
    // deliver one bot's message to another.
    if (message.from.is_bot) return { kind: 'ignored', reason: 'Sent by a bot.' };
    if (message.text === undefined || message.text.trim() === '') {
      return { kind: 'ignored', reason: 'No text — a photo, sticker or voice note.' };
    }

    return {
      kind: 'message',
      message: {
        chatRef: String(message.chat.id),
        senderRef: String(message.from.id),
        senderLabel: message.from.username !== undefined
          ? `@${message.from.username}`
          : message.from.first_name ?? String(message.from.id),
        text: message.text,
        messageRef: String(message.message_id),
      },
    };
  },

  async send(token, chatRef, text, fetchImpl = globalThis.fetch): Promise<void> {
    for (const part of chunk(text)) {
      await call(token, 'sendMessage', { chat_id: chatRef, text: part }, fetchImpl);
    }
  },
};
