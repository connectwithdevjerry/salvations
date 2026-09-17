/**
 * Discord.
 *
 * Discord has two ways to hear from a person: a Gateway WebSocket, which needs
 * a process that stays connected, and an interactions endpoint, which is plain
 * HTTPS. A serverless deployment cannot hold a socket open, so this adapter
 * uses interactions — which means a slash command rather than a free DM. The
 * catalogue says so in words, because a person who expects DMs and gets silence
 * will conclude the product is broken.
 *
 * Discord signs every delivery with Ed25519 over `timestamp + body` and will
 * disable an endpoint that fails to reject a deliberately bad signature, so the
 * check here is not optional even in development.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { ChannelError, type ChannelAdapter, type ChannelIdentity, type InboundResult } from './port';

const API = 'https://discord.com/api/v10';

/** Discord's ceiling on one message. */
export const MAX_MESSAGE_LENGTH = 2000;

const SIGNATURE_HEADER = 'x-signature-ed25519';
const TIMESTAMP_HEADER = 'x-signature-timestamp';

/** Interaction types we care about. 1 is Discord's liveness ping. */
const PING = 1;
const APPLICATION_COMMAND = 2;

/**
 * Wraps a raw 32-byte Ed25519 public key as DER so `createPublicKey` accepts it.
 *
 * Discord publishes the key as bare hex. WebCrypto's Ed25519 support has moved
 * between Node versions, and this path has not.
 */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyOf(hex: string) {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new ChannelError('discord', 'That is not a valid public key.');
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

interface DiscordUser { id: string; username: string; bot?: boolean; global_name?: string | null }

async function call<T>(
  token: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  } catch (caught) {
    throw new ChannelError('discord', `Could not reach Discord: ${String(caught)}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ChannelError(
      'discord',
      response.status === 401
        ? 'Discord rejected that bot token.'
        : `Discord refused the request (${response.status}). ${body.slice(0, 200)}`,
      response.status,
    );
  }
  return await response.json() as T;
}

export const discordAdapter: ChannelAdapter = {
  channelId: 'discord',

  secondarySecret: {
    label: 'Application public key',
    help: 'On the application\'s General Information page. Discord signs every delivery ' +
      'with it, and an endpoint that cannot check the signature is one Discord will ' +
      'turn off.',
  },

  async identify(token, fetchImpl = globalThis.fetch): Promise<ChannelIdentity> {
    const me = await call<DiscordUser>(token, '/users/@me', { method: 'GET' }, fetchImpl);
    if (me.bot !== true) {
      throw new ChannelError('discord', 'That token belongs to a user, not a bot.');
    }
    return {
      handle: `@${me.username}`,
      displayName: me.global_name ?? me.username,
      botRef: me.id,
    };
  },

  // Discord's interactions endpoint is set in its own dashboard, not over the
  // API, so there is nothing to register or undo. Saying so here is clearer
  // than an adapter that quietly does nothing.
  async register(): Promise<void> { /* configured in the developer portal */ },
  async unregister(): Promise<void> { /* configured in the developer portal */ },

  receive(raw, headers, context): InboundResult {
    const signature = headers.get(SIGNATURE_HEADER);
    const timestamp = headers.get(TIMESTAMP_HEADER);
    if (signature === null || timestamp === null) {
      return { kind: 'rejected', reason: 'The delivery was not signed.' };
    }

    // A malformed public key, a signature that is not hex, or a verification
    // that simply fails are all one answer: not from Discord.
    const valid = ((): boolean => {
      try {
        return verifySignature(
          null,
          Buffer.from(timestamp + raw, 'utf8'),
          publicKeyOf(context.webhookSecret),
          Buffer.from(signature, 'hex'),
        );
      } catch {
        return false;
      }
    })();
    if (!valid) return { kind: 'rejected', reason: 'The signature did not verify.' };

    let body: {
      type?: number;
      id?: string;
      channel_id?: string;
      member?: { user?: DiscordUser };
      user?: DiscordUser;
      data?: { options?: { name: string; value?: unknown }[] };
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return { kind: 'rejected', reason: 'The delivery was not JSON.' };
    }

    // Discord pings a new endpoint before it will save it, and expects the
    // exact shape back. Answering anything else means the URL cannot be set.
    if (body.type === PING) {
      return { kind: 'challenge', body: JSON.stringify({ type: PING }), contentType: 'application/json' };
    }
    if (body.type !== APPLICATION_COMMAND) {
      return { kind: 'ignored', reason: 'Not a command.' };
    }

    const user = body.member?.user ?? body.user;
    const text = body.data?.options?.find((o) => o.name === 'message')?.value;
    if (user === undefined || body.channel_id === undefined || typeof text !== 'string') {
      return { kind: 'ignored', reason: 'A command with nothing to say.' };
    }

    return {
      kind: 'message',
      message: {
        chatRef: body.channel_id,
        senderRef: user.id,
        senderLabel: `@${user.username}`,
        text,
        messageRef: body.id ?? `${body.channel_id}:${Date.now()}`,
      },
    };
  },

  async send(token, chatRef, text, fetchImpl = globalThis.fetch): Promise<void> {
    for (const part of split(text, MAX_MESSAGE_LENGTH)) {
      await call(token, `/channels/${chatRef}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: part }),
      }, fetchImpl);
    }
  },
};

/** Shared with Telegram in spirit, not in code: the ceilings differ. */
export function split(text: string, limit: number): readonly string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const breakAt = window.lastIndexOf('\n');
    const cut = breakAt > limit * 0.75 ? breakAt : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest !== '') parts.push(rest);
  return parts;
}
