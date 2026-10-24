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
 * The command itself is ours to create: Discord has no dashboard for slash
 * commands, so `register` creates `/hive` on the application, and a person
 * who has pasted a token and invited the bot has nothing else to do.
 *
 * Discord reads the HTTP response to an interaction as the bot's first word,
 * so a command is answered with a short acknowledgement in the response
 * itself, and a button press with the rewritten message. A plain 200 would be
 * shown as "the application did not respond", however well the reply that
 * follows lands.
 *
 * Discord signs every delivery with Ed25519 over `timestamp + body` and will
 * disable an endpoint that fails to reject a deliberately bad signature, so the
 * check here is not optional even in development.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  ChannelError, type Ack, type ChannelAdapter, type ChannelIdentity, type Choice, type InboundChoice, type InboundResult,
} from './port';

const API = 'https://discord.com/api/v10';

/** Discord's ceiling on one message. */
export const MAX_MESSAGE_LENGTH = 2000;

const SIGNATURE_HEADER = 'x-signature-ed25519';
const TIMESTAMP_HEADER = 'x-signature-timestamp';

/** Interaction types we care about. 1 is Discord's liveness ping. */
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;

/** Interaction response types. */
const CHANNEL_MESSAGE = 4;
const UPDATE_MESSAGE = 7;

/** Message component types and button styles. */
const ACTION_ROW = 1;
const BUTTON = 2;
const PRIMARY = 1;
const SECONDARY = 2;

/** The slash command, as the person types it. */
export const COMMAND_NAME = 'hive';
const COMMAND_OPTION = 'message';

/** What the response to a command says, before the answer arrives. */
export const COMMAND_ACK = 'On it.';

/** Discord's flag for a response only the person who asked can see. */
const EPHEMERAL = 64;

/**
 * Which server an interaction came from, for an application that serves
 * many of them from one endpoint. Undefined for a ping, for a DM with the
 * bot (Discord names no server there), and for anything unparseable.
 */
export function discordGuildOf(raw: string): string | undefined {
  try {
    const body = JSON.parse(raw) as { guild_id?: unknown };
    return typeof body.guild_id === 'string' ? body.guild_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The answer for a command used somewhere the shared application cannot
 * place: a DM with the bot. Said in the response, since Discord shows a
 * silent response as "the application did not respond".
 */
export const NOT_IN_SERVER: Ack = {
  body: JSON.stringify({
    type: 4,
    data: { content: 'Use /hive in a server where the assistant was added. Direct messages are not connected.', flags: EPHEMERAL },
  }),
  contentType: 'application/json',
};

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
  // Typing and a few other calls answer 204 with nothing to parse.
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

const json = (body: unknown): Ack => ({ body: JSON.stringify(body), contentType: 'application/json' });

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

const labelOf = (user: DiscordUser): string => `@${user.username}`;

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

  /**
   * Creates the slash command on the application.
   *
   * The interactions endpoint itself is set in Discord's dashboard, not over
   * the API; the command is the part Discord has no dashboard for. Creating
   * a command by name a second time updates it, so this is safe to repeat
   * every time the registration is refreshed.
   */
  async register(token, _context, fetchImpl = globalThis.fetch): Promise<void> {
    const app = await call<{ id?: string }>(token, '/oauth2/applications/@me', { method: 'GET' }, fetchImpl);
    if (app.id === undefined) throw new ChannelError('discord', 'Discord would not say which application this bot belongs to.');
    await call(token, `/applications/${app.id}/commands`, post({
      name: COMMAND_NAME,
      description: 'Ask your assistant, or tell it something',
      type: 1,
      options: [{ type: 3, name: COMMAND_OPTION, description: 'What to ask or tell it', required: true }],
      // In a server it was invited to, and in a direct message with the bot.
      contexts: [0, 1],
    }), fetchImpl);
  },

  // Leaving the command behind is harmless: without the endpoint it reaches
  // nothing, and a reconnect recreates it under the same name.
  async unregister(): Promise<void> { /* the endpoint is configured in the developer portal */ },

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
      token?: string;
      channel_id?: string;
      member?: { user?: DiscordUser };
      user?: DiscordUser;
      message?: { id?: string };
      data?: { options?: { name: string; value?: unknown }[]; custom_id?: string };
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

    const user = body.member?.user ?? body.user;

    // A press on one of our buttons. The data is ours; who pressed is theirs
    // to assert and the caller's to check.
    if (body.type === MESSAGE_COMPONENT) {
      const data = body.data?.custom_id;
      if (user === undefined || body.channel_id === undefined || data === undefined || body.message?.id === undefined || body.id === undefined) {
        return { kind: 'ignored', reason: 'A press with nothing to act on.' };
      }
      return {
        kind: 'choice',
        choice: {
          chatRef: body.channel_id,
          senderRef: user.id,
          senderLabel: labelOf(user),
          data,
          callbackRef: body.id,
          messageRef: body.message.id,
          deliveryRef: `press:${body.id}`,
        },
      };
    }

    if (body.type !== APPLICATION_COMMAND) {
      return { kind: 'ignored', reason: 'Not a command.' };
    }

    const text = body.data?.options?.find((o) => o.name === COMMAND_OPTION)?.value;
    if (user === undefined || body.channel_id === undefined || typeof text !== 'string') {
      return { kind: 'ignored', reason: 'A command with nothing to say.' };
    }

    return {
      kind: 'message',
      message: {
        chatRef: body.channel_id,
        senderRef: user.id,
        senderLabel: labelOf(user),
        text,
        messageRef: body.id ?? `${body.channel_id}:${Date.now()}`,
      },
      // The response Discord shows under the command. The answer follows as
      // a message of its own once the run has it.
      ack: json({ type: CHANNEL_MESSAGE, data: { content: COMMAND_ACK } }),
    };
  },

  async send(token, chatRef, text, fetchImpl = globalThis.fetch): Promise<void> {
    for (const part of split(text, MAX_MESSAGE_LENGTH)) {
      await call(token, `/channels/${chatRef}/messages`, post({ content: part }), fetchImpl);
    }
  },

  async sendMedia(token, chatRef, media, fetchImpl = globalThis.fetch): Promise<void> {
    // A picture goes in an embed, which Discord fetches and shows at full
    // width. A clip goes as its link: Discord plays a linked video inline,
    // and an embed cannot carry one.
    const caption = media.caption !== undefined ? split(media.caption, MAX_MESSAGE_LENGTH)[0] : undefined;
    await call(token, `/channels/${chatRef}/messages`, post(
      media.kind === 'image'
        ? { ...(caption !== undefined ? { content: caption } : {}), embeds: [{ image: { url: media.url } }] }
        : { content: caption !== undefined ? `${caption}\n${media.url}` : media.url },
    ), fetchImpl);
  },

  async sendChoices(token, chatRef, text, choices: readonly Choice[], fetchImpl = globalThis.fetch): Promise<string> {
    const sent = await call<{ id: string }>(token, `/channels/${chatRef}/messages`, post({
      content: split(text, MAX_MESSAGE_LENGTH)[0] ?? text,
      components: [{
        type: ACTION_ROW,
        components: choices.map((c, i) => ({ type: BUTTON, style: i === 0 ? PRIMARY : SECONDARY, label: c.label, custom_id: c.data })),
      }],
    }), fetchImpl);
    return sent.id;
  },

  /** The press is answered in the response: the message, rewritten without its buttons. */
  ackChoice(_choice: InboundChoice, text: string): Ack {
    return json({ type: UPDATE_MESSAGE, data: { content: split(text, MAX_MESSAGE_LENGTH)[0] ?? text, components: [] } });
  },

  /** "typing…" in the channel. Discord shows it for about ten seconds. */
  async indicate(token, chatRef, fetchImpl = globalThis.fetch): Promise<void> {
    await call(token, `/channels/${chatRef}/typing`, { method: 'POST' }, fetchImpl);
  },

  async sendDraft(token, chatRef, text, fetchImpl = globalThis.fetch): Promise<string> {
    const sent = await call<{ id: string }>(
      token, `/channels/${chatRef}/messages`, post({ content: split(text, MAX_MESSAGE_LENGTH)[0] ?? text }), fetchImpl,
    );
    return sent.id;
  },

  async editDraft(token, chatRef, messageRef, text, fetchImpl = globalThis.fetch): Promise<void> {
    await call(token, `/channels/${chatRef}/messages/${messageRef}`, {
      method: 'PATCH', body: JSON.stringify({ content: split(text, MAX_MESSAGE_LENGTH)[0] ?? text }),
    }, fetchImpl);
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
