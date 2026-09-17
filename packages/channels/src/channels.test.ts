import { createHmac, generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { channelAdapter, CHANNEL_IDS, ChannelError } from './index';
import { telegramAdapter, chunk, SECRET_HEADER } from './telegram';
import { discordAdapter } from './discord';
import { slackAdapter, MAX_SKEW_SECONDS } from './slack';

const CONTEXT = { webhookUrl: 'https://example.test/hook', webhookSecret: 'sekrit-token-value' };

/** A fetch that answers one canned body and records what it was asked. */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('the registry', () => {
  it('maps every catalogue channel id to an adapter', () => {
    for (const id of CHANNEL_IDS) {
      expect(channelAdapter(id)?.channelId).toBe(id);
    }
  });

  it('returns undefined for an id it does not have', () => {
    // A stored row can name a channel a later version removed. That has to
    // degrade, not throw on the integrations page.
    expect(channelAdapter('carrier-pigeon')).toBeUndefined();
  });
});

describe('telegram', () => {
  it('identifies a bot and does not put the token in the body', async () => {
    const { impl, calls } = stubFetch({ ok: true, result: { id: 7, is_bot: true, username: 'hive_bot' } });
    const identity = await telegramAdapter.identify('123:ABC', impl);

    expect(identity).toEqual({ handle: '@hive_bot', displayName: 'hive_bot', botRef: '7' });
    // The token belongs in the path and nowhere else — a body gets logged.
    expect(calls[0]?.init.body).toBe('{}');
  });

  it('refuses a token that is not a bot', async () => {
    const { impl } = stubFetch({ ok: true, result: { id: 7, is_bot: false } });
    await expect(telegramAdapter.identify('123:ABC', impl)).rejects.toThrow(/does not belong to a bot/);
  });

  it("passes Telegram's own description through on refusal", async () => {
    const { impl } = stubFetch({ ok: false, description: 'Unauthorized' }, 401);
    // "Unauthorized" is the actual diagnosis. Replacing it with something of
    // our own would cost the person the one useful word.
    await expect(telegramAdapter.identify('bad', impl)).rejects.toThrow('Unauthorized');
  });

  it('asks only for message updates', async () => {
    const { impl, calls } = stubFetch({ ok: true, result: true });
    await telegramAdapter.register('123:ABC', CONTEXT, impl);

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['allowed_updates']).toEqual(['message']);
    expect(body['secret_token']).toBe(CONTEXT.webhookSecret);
  });

  const delivery = (message: unknown) => JSON.stringify({ update_id: 1, message });
  const withSecret = (secret: string) => new Headers({ [SECRET_HEADER]: secret });

  it('rejects a delivery with no secret', () => {
    const result = telegramAdapter.receive(delivery({}), new Headers(), CONTEXT);
    expect(result.kind).toBe('rejected');
  });

  it('rejects a delivery with the wrong secret', () => {
    const result = telegramAdapter.receive(delivery({}), withSecret('wrong-length-ish!'), CONTEXT);
    expect(result.kind).toBe('rejected');
  });

  it('accepts a real message', () => {
    const result = telegramAdapter.receive(
      delivery({
        message_id: 42,
        from: { id: 9, is_bot: false, username: 'ada' },
        chat: { id: -100, type: 'private' },
        text: 'hello',
      }),
      withSecret(CONTEXT.webhookSecret),
      CONTEXT,
    );

    expect(result).toEqual({
      kind: 'message',
      message: {
        chatRef: '-100', senderRef: '9', senderLabel: '@ada', text: 'hello', messageRef: '42',
      },
    });
  });

  it('ignores a message from another bot', () => {
    // Two bots in one chat is how a loop starts, and Telegram will deliver it.
    const result = telegramAdapter.receive(
      delivery({
        message_id: 1, from: { id: 9, is_bot: true }, chat: { id: 1, type: 'private' }, text: 'hi',
      }),
      withSecret(CONTEXT.webhookSecret),
      CONTEXT,
    );
    expect(result.kind).toBe('ignored');
  });

  it('ignores a photo, which has no text', () => {
    const result = telegramAdapter.receive(
      delivery({ message_id: 1, from: { id: 9, is_bot: false }, chat: { id: 1, type: 'private' } }),
      withSecret(CONTEXT.webhookSecret),
      CONTEXT,
    );
    expect(result.kind).toBe('ignored');
  });

  it('sends a long answer as several messages, each inside the limit', async () => {
    const { impl, calls } = stubFetch({ ok: true, result: {} });
    const long = `${'a'.repeat(5000)}\n${'b'.repeat(200)}`;
    await telegramAdapter.send('123:ABC', '-100', long, impl);

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      const body = JSON.parse(String(call.init.body)) as { text: string };
      expect(body.text.length).toBeLessThanOrEqual(4096);
    }
  });

  it('rejoins into exactly the text it was given', () => {
    const text = `${'x'.repeat(4090)}\n${'y'.repeat(50)}`;
    expect(chunk(text).join('\n')).toBe(text);
  });
});

describe('discord', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const context = { webhookUrl: 'https://example.test/d', webhookSecret: raw };

  const signed = (body: string, timestamp = '1700000000') =>
    new Headers({
      'x-signature-ed25519': signEd25519(null, Buffer.from(timestamp + body), privateKey).toString('hex'),
      'x-signature-timestamp': timestamp,
    });

  it('answers the ping with the shape Discord demands', () => {
    // Discord refuses to save an endpoint that answers its ping with anything
    // else, so this is the difference between working and unconfigurable.
    const body = JSON.stringify({ type: 1 });
    const result = discordAdapter.receive(body, signed(body), context);

    expect(result).toEqual({ kind: 'challenge', body: '{"type":1}', contentType: 'application/json' });
  });

  it('rejects an unsigned delivery', () => {
    const body = JSON.stringify({ type: 1 });
    expect(discordAdapter.receive(body, new Headers(), context).kind).toBe('rejected');
  });

  it('rejects a signature over a different body', () => {
    // Discord actively probes an endpoint with a bad signature and disables one
    // that accepts it, so this is not a hypothetical.
    const headers = signed(JSON.stringify({ type: 1 }));
    const result = discordAdapter.receive(JSON.stringify({ type: 2 }), headers, context);
    expect(result.kind).toBe('rejected');
  });

  it('rejects a signature made with another key', () => {
    const other = generateKeyPairSync('ed25519');
    const body = JSON.stringify({ type: 1 });
    const headers = new Headers({
      'x-signature-ed25519': signEd25519(null, Buffer.from(`1700000000${body}`), other.privateKey).toString('hex'),
      'x-signature-timestamp': '1700000000',
    });
    expect(discordAdapter.receive(body, headers, context).kind).toBe('rejected');
  });

  it('reads a command into a message', () => {
    const body = JSON.stringify({
      type: 2,
      id: 'int_1',
      channel_id: 'chan_1',
      member: { user: { id: 'u1', username: 'ada' } },
      data: { options: [{ name: 'message', value: 'what is on my calendar' }] },
    });
    const result = discordAdapter.receive(body, signed(body), context);

    expect(result).toMatchObject({
      kind: 'message',
      message: { chatRef: 'chan_1', senderRef: 'u1', text: 'what is on my calendar' },
    });
  });

  it('refuses a public key that is not one', () => {
    const body = JSON.stringify({ type: 1 });
    const bad = { ...context, webhookSecret: 'not-hex' };
    expect(discordAdapter.receive(body, signed(body), bad).kind).toBe('rejected');
  });
});

describe('slack', () => {
  const secret = 'signing-secret';
  const context = { webhookUrl: 'https://example.test/s', webhookSecret: secret };

  const signed = (body: string, timestamp = Math.floor(Date.now() / 1000)) => {
    const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
    return new Headers({
      'x-slack-signature': `v0=${digest}`,
      'x-slack-request-timestamp': String(timestamp),
    });
  };

  it('echoes the url_verification challenge as plain text', () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const result = slackAdapter.receive(body, signed(body), context);

    expect(result).toEqual({ kind: 'challenge', body: 'abc123', contentType: 'text/plain' });
  });

  it('rejects a correctly signed but stale delivery', () => {
    // The signature verifies. The body is two hours old. That is a replay, and
    // checking the signature alone would accept it.
    const stale = Math.floor(Date.now() / 1000) - (MAX_SKEW_SECONDS + 7200);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const result = slackAdapter.receive(body, signed(body, stale), context);

    expect(result).toEqual({ kind: 'rejected', reason: 'The delivery is too old to accept.' });
  });

  it('rejects a signature made with a different secret', () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', 'wrong').update(`v0:${timestamp}:${body}`).digest('hex');
    const headers = new Headers({
      'x-slack-signature': `v0=${digest}`,
      'x-slack-request-timestamp': String(timestamp),
    });
    expect(slackAdapter.receive(body, headers, context).kind).toBe('rejected');
  });

  it('ignores its own posts', () => {
    // Slack echoes the bot's own messages back. Acting on one is a conversation
    // with itself that never ends.
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', bot_id: 'B1' },
    });
    expect(slackAdapter.receive(body, signed(body), context).kind).toBe('ignored');
  });

  it('ignores an edit, which arrives as a message with a subtype', () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', subtype: 'message_changed', channel: 'C1', user: 'U1', text: 'hi' },
    });
    expect(slackAdapter.receive(body, signed(body), context).kind).toBe('ignored');
  });

  it('accepts a real message', () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hello', ts: '1.2' },
    });
    expect(slackAdapter.receive(body, signed(body), context)).toEqual({
      kind: 'message',
      message: { chatRef: 'C1', senderRef: 'U1', senderLabel: 'U1', text: 'hello', messageRef: '1.2' },
    });
  });

  it('translates a Slack error code into something actionable', async () => {
    const { impl } = stubFetch({ ok: false, error: 'missing_scope' });
    // Slack answers 200 with ok:false, so the status code says nothing and its
    // error code is the entire diagnosis.
    await expect(slackAdapter.identify('xoxb-bad', impl)).rejects.toThrow(/chat:write/);
  });

  it('carries the channel id on a ChannelError', async () => {
    const { impl } = stubFetch({ ok: false, error: 'invalid_auth' });
    await expect(slackAdapter.identify('xoxb-bad', impl)).rejects.toMatchObject({
      name: 'ChannelError', channelId: 'slack',
    });
    expect(new ChannelError('slack', 'x').channelId).toBe('slack');
  });
});
