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
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ChannelError, type ChannelAdapter, type ChannelIdentity, type InboundResult } from './port';
import { split } from './discord';

const API = 'https://slack.com/api';

/** Slack's practical ceiling on one message. */
export const MAX_MESSAGE_LENGTH = 3000;

const SIGNATURE_HEADER = 'x-slack-signature';
const TIMESTAMP_HEADER = 'x-slack-request-timestamp';
const VERSION = 'v0';

/** How stale a delivery may be. Slack's own recommendation. */
export const MAX_SKEW_SECONDS = 300;

interface SlackResponse { ok: boolean; error?: string; [key: string]: unknown }

async function call<T extends SlackResponse>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
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
  missing_scope: 'The app is missing a scope. It needs chat:write, im:history and app_mentions:read.',
  channel_not_found: 'Slack cannot see that channel. The bot may need inviting to it.',
  not_in_channel: 'The bot is not in that channel yet.',
};

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

    let body: {
      type?: string;
      challenge?: string;
      event?: {
        type?: string; subtype?: string; channel?: string; user?: string;
        text?: string; ts?: string; bot_id?: string;
      };
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return { kind: 'rejected', reason: 'The delivery was not JSON.' };
    }

    // Slack will not save a request URL until it has posted a challenge to it
    // and read the value straight back.
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      return { kind: 'challenge', body: body.challenge, contentType: 'text/plain' };
    }

    const event = body.event;
    if (event?.type !== 'message' && event?.type !== 'app_mention') {
      return { kind: 'ignored', reason: 'Not a message.' };
    }
    // Slack echoes the bot's own posts back as events. Acting on one is an
    // infinite conversation with itself.
    if (event.bot_id !== undefined) return { kind: 'ignored', reason: 'Sent by a bot.' };
    // Edits, deletions, joins and file shares all arrive as `message` with a
    // subtype. None of them is somebody saying something.
    if (event.subtype !== undefined) return { kind: 'ignored', reason: `Message subtype ${event.subtype}.` };
    if (event.channel === undefined || event.user === undefined) {
      return { kind: 'ignored', reason: 'A message with no channel or sender.' };
    }
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
};
