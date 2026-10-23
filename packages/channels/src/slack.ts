/**
 * Slack.
 *
 * Slack signs deliveries with a signing secret that is NOT the bot token — two
 * different secrets from two different pages of its dashboard — so this adapter
 * declares a secondary field rather than pretending one value does both jobs.
 *
 * The timestamp in the signature base string is checked as well as the
 * signature. A valid signature on a five-hour-old body is still a replay, and
 * Slack's own guidance is to reject anything older than five minutes.
 *
 * Two kinds of delivery arrive at the one URL: events, as JSON, and button
 * presses, as a form whose `payload` field is JSON. Both are signed the same
 * way over the raw bytes, so the check comes first and the shape second.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ChannelError, type ChannelAdapter, type ChannelIdentity, type Choice, type InboundAudio, type InboundResult,
} from './port';
import { split } from './discord';
import { MAX_AUDIO_BYTES } from './telegram';

const API = 'https://slack.com/api';

/** Slack's practical ceiling on one message. */
export const MAX_MESSAGE_LENGTH = 3000;

const SIGNATURE_HEADER = 'x-slack-signature';
const TIMESTAMP_HEADER = 'x-slack-request-timestamp';
const VERSION = 'v0';

/** How stale a delivery may be. Slack's own recommendation. */
export const MAX_SKEW_SECONDS = 300;

/** The scopes a bot needs for everything here. Named in one place, quoted in errors. */
export const SCOPES = 'chat:write, im:history, app_mentions:read, files:read and files:write';

interface SlackResponse { ok: boolean; error?: string; [key: string]: unknown }

interface SlackFile {
  id?: string; mimetype?: string; url_private_download?: string; url_private?: string;
  size?: number; duration_ms?: number; name?: string;
}

async function call<T extends SlackResponse>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  return await request<T>(token, method, {
    'content-type': 'application/json; charset=utf-8',
  }, JSON.stringify(body), fetchImpl);
}

/** A few methods take form fields, not JSON; Slack says so per method. */
async function callForm<T extends SlackResponse>(
  token: string,
  method: string,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<T> {
  return await request<T>(token, method, {
    'content-type': 'application/x-www-form-urlencoded',
  }, new URLSearchParams(fields).toString(), fetchImpl);
}

async function request<T extends SlackResponse>(
  token: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
    });
  } catch (caught) {
    throw new ChannelError('slack', `Could not reach Slack: ${String(caught)}`);
  }

  const parsed = await response.json().catch(() => undefined) as T | undefined;
  if (parsed?.ok !== true) {
    // Slack answers 200 with `ok: false` for most failures, so the status code
    // is nearly useless here and its `error` code is the real answer.
    const code = parsed?.error ?? `http_${response.status}`;
    throw new ChannelError('slack', SLACK_ERRORS[code] ?? `Slack refused the request: ${code}.`, response.status);
  }
  return parsed;
}

/** The handful of Slack error codes a person setting this up will actually hit. */
const SLACK_ERRORS: Readonly<Record<string, string>> = {
  invalid_auth: 'Slack rejected that token. Check it starts with "xoxb-".',
  account_inactive: 'That token belongs to a deactivated app.',
  missing_scope: `The app is missing a scope. It needs ${SCOPES}.`,
  channel_not_found: 'Slack cannot see that channel. The bot may need inviting to it.',
  not_in_channel: 'The bot is not in that channel yet.',
};

/**
 * Which Slack workspace a delivery came from.
 *
 * Needed when one Slack app serves many connections: an event names its
 * workspace as `team_id` at the top level, a button press as `team.id`
 * inside the form's `payload`. Undefined for a URL challenge, which belongs
 * to no workspace, and for anything unparseable.
 */
export function slackTeamOf(raw: string): string | undefined {
  const isForm = raw.startsWith('payload=');
  const text = isForm ? new URLSearchParams(raw).get('payload') : raw;
  if (text === null) return undefined;
  try {
    const body = JSON.parse(text) as { team_id?: unknown; team?: { id?: unknown } };
    if (typeof body.team_id === 'string') return body.team_id;
    if (typeof body.team?.id === 'string') return body.team.id;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Revokes a bot token at Slack. For a token issued to this deployment's own
 * app: once revoked, the installation is dead until the workspace installs
 * the app again. Best effort; a token Slack no longer knows is already gone.
 */
export async function revokeSlackToken(token: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
  await callForm(token, 'auth.revoke', {}, fetchImpl);
}

/** The first audio file on a message, as something the caller can fetch later. */
function audioIn(files: readonly SlackFile[] | undefined): InboundAudio | undefined {
  const file = files?.find((f) => typeof f.mimetype === 'string' && f.mimetype.startsWith('audio/'));
  const url = file?.url_private_download ?? file?.url_private;
  if (file === undefined || url === undefined) return undefined;
  return {
    fileRef: url,
    mimeType: file.mimetype as string,
    ...(file.duration_ms !== undefined ? { durationSeconds: file.duration_ms / 1000 } : {}),
    ...(file.size !== undefined ? { sizeBytes: file.size } : {}),
  };
}

/** The message's words and buttons, as Slack's Block Kit wants them. */
const blocksFor = (text: string, choices: readonly Choice[]): unknown[] => [
  { type: 'section', text: { type: 'plain_text', text, emoji: true } },
  {
    type: 'actions',
    elements: choices.map((c, i) => ({
      type: 'button',
      action_id: `choice_${i}`,
      text: { type: 'plain_text', text: c.label, emoji: true },
      value: c.data,
      ...(i === 0 ? { style: 'primary' } : {}),
    })),
  },
];

export const slackAdapter: ChannelAdapter = {
  channelId: 'slack',

  secondarySecret: {
    label: 'Signing secret',
    help: 'Under Basic Information → App Credentials. Different from the bot token: ' +
      'Slack signs deliveries with this one and authorises calls with the other.',
  },

  async identify(token, fetchImpl = globalThis.fetch): Promise<ChannelIdentity> {
    const me = await call<SlackResponse & { user?: string; user_id?: string; team?: string }>(
      token, 'auth.test', {}, fetchImpl,
    );
    if (typeof me.user_id !== 'string') {
      throw new ChannelError('slack', 'Slack accepted the token but did not say who it is.');
    }
    return {
      handle: me.user === undefined ? me.user_id : `@${me.user}`,
      displayName: typeof me.team === 'string' ? `${me.user ?? 'bot'} · ${me.team}` : me.user ?? 'bot',
      botRef: me.user_id,
    };
  },

  // Slack's request URL is entered in its dashboard, and it verifies the URL by
  // posting a challenge to it — which `receive` answers.
  async register(): Promise<void> { /* configured at api.slack.com/apps */ },
  async unregister(): Promise<void> { /* configured at api.slack.com/apps */ },

  receive(raw, headers, context): InboundResult {
    const signature = headers.get(SIGNATURE_HEADER);
    const timestamp = headers.get(TIMESTAMP_HEADER);
    if (signature === null || timestamp === null) {
      return { kind: 'rejected', reason: 'The delivery was not signed.' };
    }

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > MAX_SKEW_SECONDS) {
      // A correct signature over an old body is still a replay.
      return { kind: 'rejected', reason: 'The delivery is too old to accept.' };
    }

    const expected = `${VERSION}=${createHmac('sha256', context.webhookSecret)
      .update(`${VERSION}:${timestamp}:${raw}`)
      .digest('hex')}`;
    const presented = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    if (presented.length !== computed.length || !timingSafeEqual(presented, computed)) {
      return { kind: 'rejected', reason: 'The signature did not verify.' };
    }

    // A press arrives as a form with the interaction as JSON in `payload`;
    // everything else is JSON on its own.
    const isForm = (headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded') || raw.startsWith('payload=');
    const text = isForm ? new URLSearchParams(raw).get('payload') : raw;
    if (text === null) return { kind: 'ignored', reason: 'A form with no payload.' };

    let body: {
      type?: string;
      challenge?: string;
      event?: {
        type?: string; subtype?: string; channel?: string; user?: string;
        text?: string; ts?: string; bot_id?: string; files?: SlackFile[];
      };
      user?: { id?: string; username?: string; name?: string };
      channel?: { id?: string };
      message?: { ts?: string };
      actions?: { action_id?: string; value?: string }[];
      trigger_id?: string;
      response_url?: string;
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return { kind: 'rejected', reason: 'The delivery was not JSON.' };
    }

    // Slack will not save a request URL until it has posted a challenge to it
    // and read the value straight back.
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      return { kind: 'challenge', body: body.challenge, contentType: 'text/plain' };
    }

    if (body.type === 'block_actions') {
      const data = body.actions?.[0]?.value;
      const chatRef = body.channel?.id;
      const senderRef = body.user?.id;
      const messageRef = body.message?.ts;
      if (data === undefined || chatRef === undefined || senderRef === undefined || messageRef === undefined || body.trigger_id === undefined) {
        return { kind: 'ignored', reason: 'A press with nothing to act on.' };
      }
      return {
        kind: 'choice',
        choice: {
          chatRef,
          senderRef,
          senderLabel: body.user?.username !== undefined ? `@${body.user.username}` : body.user?.name ?? senderRef,
          data,
          callbackRef: body.response_url ?? '',
          messageRef,
          deliveryRef: `press:${body.trigger_id}`,
        },
      };
    }

    const event = body.event;
    if (event?.type !== 'message' && event?.type !== 'app_mention') {
      return { kind: 'ignored', reason: 'Not a message.' };
    }
    // Slack echoes the bot's own posts back as events. Acting on one is an
    // infinite conversation with itself.
    if (event.bot_id !== undefined) return { kind: 'ignored', reason: 'Sent by a bot.' };
    if (event.channel === undefined || event.user === undefined) {
      return { kind: 'ignored', reason: 'A message with no channel or sender.' };
    }

    // A voice clip or an audio file is something they said, whichever
    // subtype Slack files it under. Looked for before the subtype check,
    // because a share arrives as `file_share`.
    const audio = audioIn(event.files);
    if (audio !== undefined) {
      if ((audio.sizeBytes ?? 0) > MAX_AUDIO_BYTES) {
        return { kind: 'ignored', reason: 'A recording too large to fetch.' };
      }
      return {
        kind: 'message',
        message: {
          chatRef: event.channel,
          senderRef: event.user,
          senderLabel: event.user,
          text: event.text ?? '',
          audio,
          messageRef: event.ts ?? `${event.channel}:${Date.now()}`,
        },
      };
    }

    // Edits, deletions, joins and file shares all arrive as `message` with a
    // subtype. None of them is somebody saying something.
    if (event.subtype !== undefined) return { kind: 'ignored', reason: `Message subtype ${event.subtype}.` };
    if (event.text === undefined || event.text.trim() === '') {
      return { kind: 'ignored', reason: 'No text.' };
    }

    return {
      kind: 'message',
      message: {
        chatRef: event.channel,
        senderRef: event.user,
        senderLabel: event.user,
        text: event.text,
        messageRef: event.ts ?? `${event.channel}:${Date.now()}`,
      },
    };
  },

  async send(token, chatRef, text, fetchImpl = globalThis.fetch): Promise<void> {
    for (const part of split(text, MAX_MESSAGE_LENGTH)) {
      await call(token, 'chat.postMessage', { channel: chatRef, text: part }, fetchImpl);
    }
  },

  /**
   * A picture goes in an image block, which Slack fetches from the link. A
   * clip is uploaded as a file, because a linked video is a link in Slack
   * and an uploaded one plays in the channel.
   */
  async sendMedia(token, chatRef, media, fetchImpl = globalThis.fetch): Promise<void> {
    const caption = media.caption !== undefined ? split(media.caption, MAX_MESSAGE_LENGTH)[0] : undefined;
    if (media.kind === 'image') {
      await call(token, 'chat.postMessage', {
        channel: chatRef,
        text: caption ?? 'A picture',
        blocks: [
          ...(caption !== undefined ? [{ type: 'section', text: { type: 'plain_text', text: caption, emoji: true } }] : []),
          { type: 'image', image_url: media.url, alt_text: caption ?? 'A picture from your assistant' },
        ],
      }, fetchImpl);
      return;
    }

    const fetched = await fetchImpl(media.url);
    if (!fetched.ok) throw new ChannelError('slack', `Could not fetch the clip to upload (${fetched.status}).`, fetched.status);
    const bytes = await fetched.arrayBuffer();
    const filename = 'clip.mp4';

    const ticket = await callForm<SlackResponse & { upload_url?: string; file_id?: string }>(
      token, 'files.getUploadURLExternal', { filename, length: String(bytes.byteLength) }, fetchImpl,
    );
    if (ticket.upload_url === undefined || ticket.file_id === undefined) {
      throw new ChannelError('slack', 'Slack did not say where to upload the clip.');
    }
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: fetched.headers.get('content-type') ?? 'video/mp4' }), filename);
    const uploaded = await fetchImpl(ticket.upload_url, { method: 'POST', body: form });
    if (!uploaded.ok) throw new ChannelError('slack', `Slack refused the clip (${uploaded.status}).`, uploaded.status);

    await call(token, 'files.completeUploadExternal', {
      files: [{ id: ticket.file_id, title: caption ?? 'A clip from your assistant' }],
      channel_id: chatRef,
      ...(caption !== undefined ? { initial_comment: caption } : {}),
    }, fetchImpl);
  },

  async sendChoices(token, chatRef, text, choices: readonly Choice[], fetchImpl = globalThis.fetch): Promise<string> {
    const first = split(text, MAX_MESSAGE_LENGTH)[0] ?? text;
    const sent = await call<SlackResponse & { ts?: string }>(token, 'chat.postMessage', {
      channel: chatRef, text: first, blocks: blocksFor(first, choices),
    }, fetchImpl);
    return sent.ts ?? '';
  },

  /** Rewrites the message without its buttons. Slack needs no acknowledgement beyond the 200. */
  async settleChoice(token, choice, text, fetchImpl = globalThis.fetch): Promise<void> {
    const first = split(text, MAX_MESSAGE_LENGTH)[0] ?? text;
    await call(token, 'chat.update', {
      channel: choice.chatRef, ts: choice.messageRef, text: first,
      blocks: [{ type: 'section', text: { type: 'plain_text', text: first, emoji: true } }],
    }, fetchImpl);
  },

  async sendDraft(token, chatRef, text, fetchImpl = globalThis.fetch): Promise<string> {
    const sent = await call<SlackResponse & { ts?: string }>(
      token, 'chat.postMessage', { channel: chatRef, text: split(text, MAX_MESSAGE_LENGTH)[0] ?? text }, fetchImpl,
    );
    return sent.ts ?? '';
  },

  async editDraft(token, chatRef, messageRef, text, fetchImpl = globalThis.fetch): Promise<void> {
    await call(token, 'chat.update', {
      channel: chatRef, ts: messageRef, text: split(text, MAX_MESSAGE_LENGTH)[0] ?? text,
    }, fetchImpl);
  },

  /**
   * Fetches a voice clip. Slack serves files behind the bot token, so the
   * bytes come here and the token goes nowhere else: the link is checked to
   * be Slack's own before the token is sent with it.
   */
  async fetchAudio(token, audio, fetchImpl = globalThis.fetch): Promise<ArrayBuffer> {
    let host: string;
    try { host = new URL(audio.fileRef).host.toLowerCase(); } catch { host = ''; }
    if (host !== 'slack.com' && !host.endsWith('.slack.com')) {
      throw new ChannelError('slack', 'That recording is not on Slack.');
    }
    const response = await fetchImpl(audio.fileRef, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new ChannelError('slack', `Slack would not serve that file (${response.status}).`, response.status);
    }
    return await response.arrayBuffer();
  },
};
