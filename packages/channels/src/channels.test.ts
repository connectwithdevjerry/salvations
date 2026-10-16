import { createHmac, generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { channelAdapter, CHANNEL_IDS, ChannelError } from './index';
import { telegramAdapter, chunk, SECRET_HEADER, MAX_AUDIO_BYTES } from './telegram';
import { discordAdapter } from './discord';
import { slackAdapter, MAX_SKEW_SECONDS } from './slack';
import { whatsappAdapter, whatsappVerifyToken } from './whatsapp';
import { imessageAdapter } from './imessage';

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

describe('telegram presence and drafts', () => {
  it('shows typing with a chat action', async () => {
    const { impl, calls } = stubFetch({ ok: true, result: true });
    await telegramAdapter.indicate?.('tok', '42', impl);
    expect(calls[0]?.url).toContain('/sendChatAction');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ chat_id: '42', action: 'typing' });
  });

  it('posts a draft and hands back the message to edit', async () => {
    const { impl } = stubFetch({ ok: true, result: { message_id: 77 } });
    expect(await telegramAdapter.sendDraft?.('tok', '42', 'Thinking', impl)).toBe('77');
  });

  it('edits the draft in place, and does not mind being told the text is unchanged', async () => {
    const { impl, calls } = stubFetch({ ok: true, result: {} });
    await telegramAdapter.editDraft?.('tok', '42', '77', 'Done.', impl);
    expect(calls[0]?.url).toContain('/editMessageText');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ chat_id: '42', message_id: 77, text: 'Done.' });

    const unchanged = stubFetch({ ok: false, description: 'Bad Request: message is not modified' }, 400);
    await expect(telegramAdapter.editDraft?.('tok', '42', '77', 'Done.', unchanged.impl)).resolves.toBeUndefined();
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
    expect(body['allowed_updates']).toEqual(['message', 'callback_query']);
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

  describe('buttons', () => {
    it('reads a press on one of our buttons, with who pressed and what it carried', () => {
      const result = telegramAdapter.receive(
        JSON.stringify({ update_id: 2, callback_query: {
          id: '777', from: { id: 9, is_bot: false, username: 'ada' },
          message: { message_id: 50, chat: { id: -100, type: 'private' } }, data: 'a:apr_1:y',
        } }),
        withSecret(CONTEXT.webhookSecret),
        CONTEXT,
      );
      expect(result).toEqual({
        kind: 'choice',
        choice: { chatRef: '-100', senderRef: '9', senderLabel: '@ada', data: 'a:apr_1:y', callbackRef: '777', messageRef: '50', deliveryRef: 'press:777' },
      });
    });

    it('ignores a press with nothing to act on', () => {
      const result = telegramAdapter.receive(
        JSON.stringify({ update_id: 2, callback_query: { id: '778', from: { id: 9, is_bot: false } } }),
        withSecret(CONTEXT.webhookSecret),
        CONTEXT,
      );
      expect(result.kind).toBe('ignored');
    });

    it('sends the question with an inline keyboard and hands back the message', async () => {
      const { impl, calls } = stubFetch({ ok: true, result: { message_id: 51 } });
      const ref = await telegramAdapter.sendChoices?.('123:ABC', '-100', 'Go ahead?', [{ label: 'Approve', data: 'a:apr_1:y' }, { label: 'Not now', data: 'a:apr_1:n' }], impl);
      expect(ref).toBe('51');
      const body = JSON.parse(String(calls[0]?.init.body)) as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
      expect(body.reply_markup.inline_keyboard[0]?.map((b) => b.callback_data)).toEqual(['a:apr_1:y', 'a:apr_1:n']);
    });

    it('settles a press: acknowledges it and rewrites the message without buttons', async () => {
      const { impl, calls } = stubFetch({ ok: true, result: true });
      await telegramAdapter.settleChoice?.('123:ABC', { chatRef: '-100', senderRef: '9', senderLabel: '@ada', data: 'x', callbackRef: '777', messageRef: '50', deliveryRef: 'press:777' }, 'Approved.', impl);
      expect(calls.map((c) => c.url.split('/').pop())).toEqual(['answerCallbackQuery', 'editMessageText']);
      const edit = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
      expect(edit['message_id']).toBe(50);
      expect(edit['reply_markup']).toBeUndefined();
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

  describe('voice notes', () => {
    const withSecret = (secret: string) => new Headers({ [SECRET_HEADER]: secret });
    const delivery = (message: unknown) => JSON.stringify({ update_id: 1, message });

    const voiceNote = (over: Record<string, unknown> = {}) => delivery({
      message_id: 7,
      from: { id: 9, is_bot: false, username: 'ada' },
      chat: { id: -100, type: 'private' },
      voice: { file_id: 'file_1', mime_type: 'audio/ogg', duration: 4, file_size: 2048 },
      ...over,
    });

    it('is no longer dropped', () => {
      // It used to be ignored outright, which gave the person silence —
      // indistinguishable from the bot being broken.
      const result = telegramAdapter.receive(
        voiceNote(), withSecret(CONTEXT.webhookSecret), CONTEXT,
      );

      expect(result).toMatchObject({
        kind: 'message',
        message: { text: '', audio: { fileRef: 'file_1', mimeType: 'audio/ogg' } },
      });
    });

    it('keeps a caption, which is also something they said', () => {
      const result = telegramAdapter.receive(
        voiceNote({ caption: 'about the meeting' }), withSecret(CONTEXT.webhookSecret), CONTEXT,
      );
      expect(result).toMatchObject({ message: { text: 'about the meeting' } });
    });

    it('treats a sent audio file the same as a held-to-talk recording', () => {
      const result = telegramAdapter.receive(
        delivery({
          message_id: 7,
          from: { id: 9, is_bot: false },
          chat: { id: -100, type: 'private' },
          audio: { file_id: 'file_2', mime_type: 'audio/mpeg' },
        }),
        withSecret(CONTEXT.webhookSecret),
        CONTEXT,
      );
      expect(result).toMatchObject({ message: { audio: { fileRef: 'file_2' } } });
    });

    it('assumes ogg when Telegram does not say', () => {
      // Telegram's own voice notes are Opus in Ogg and it often omits the type.
      const result = telegramAdapter.receive(
        voiceNote({ voice: { file_id: 'f' } }), withSecret(CONTEXT.webhookSecret), CONTEXT,
      );
      expect(result).toMatchObject({ message: { audio: { mimeType: 'audio/ogg' } } });
    });

    it('declines a recording too large to fetch', () => {
      const result = telegramAdapter.receive(
        voiceNote({ voice: { file_id: 'f', file_size: MAX_AUDIO_BYTES + 1 } }),
        withSecret(CONTEXT.webhookSecret),
        CONTEXT,
      );
      expect(result.kind).toBe('ignored');
    });

    it('still ignores a message with neither text nor audio', () => {
      const result = telegramAdapter.receive(
        delivery({
          message_id: 7, from: { id: 9, is_bot: false }, chat: { id: 1, type: 'private' },
        }),
        withSecret(CONTEXT.webhookSecret),
        CONTEXT,
      );
      expect(result.kind).toBe('ignored');
    });

    it('resolves the file and fetches it without putting the token in a body', async () => {
      const calls: string[] = [];
      const impl = (async (url: string | URL) => {
        calls.push(String(url));
        return String(url).includes('getFile')
          ? new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/f.oga' } }))
          : new Response(new Uint8Array([1, 2, 3]));
      }) as unknown as typeof fetch;

      const bytes = await telegramAdapter.fetchAudio?.(
        '123:ABC', { fileRef: 'file_1', mimeType: 'audio/ogg' }, impl,
      );

      expect(bytes?.byteLength).toBe(3);
      // Two hops: Telegram will not serve a file by id, so the path has to be
      // resolved first and then fetched from a different host.
      expect(calls[0]).toContain('getFile');
      expect(calls[1]).toContain('voice/f.oga');
    });

    it('refuses when Telegram will not say where the file is', async () => {
      const impl = (async () =>
        new Response(JSON.stringify({ ok: true, result: {} }))) as unknown as typeof fetch;

      await expect(
        telegramAdapter.fetchAudio?.('123:ABC', { fileRef: 'f', mimeType: 'audio/ogg' }, impl),
      ).rejects.toThrow(/where that file is/);
    });

    it('re-checks the size on getFile, where it is first reliable', async () => {
      // The size on the update can be absent entirely, so the only trustworthy
      // check is the one after resolution.
      const impl = (async () => new Response(JSON.stringify({
        ok: true, result: { file_path: 'v/f.oga', file_size: MAX_AUDIO_BYTES + 1 },
      }))) as unknown as typeof fetch;

      await expect(
        telegramAdapter.fetchAudio?.('123:ABC', { fileRef: 'f', mimeType: 'audio/ogg' }, impl),
      ).rejects.toThrow(/too large/);
    });
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

describe('discord as a teammate', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const context = { webhookUrl: 'https://example.test/d', webhookSecret: raw };
  const signed = (body: string, timestamp = '1700000000') =>
    new Headers({
      'x-signature-ed25519': signEd25519(null, Buffer.from(timestamp + body), privateKey).toString('hex'),
      'x-signature-timestamp': timestamp,
    });

  /** A fetch that answers each call in turn and records them. */
  function sequence(answers: readonly { body?: unknown; status?: number }[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const answer = answers[n] ?? answers[answers.length - 1] ?? {};
      n += 1;
      const status = answer.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(answer.body ?? {}), {
        status, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('creates the /hive command on the application when registered', async () => {
    const { impl, calls } = sequence([{ body: { id: 'app_1' } }, { body: { id: 'cmd_1' } }]);
    await discordAdapter.register('tok', context, impl);
    expect(calls[0]?.url).toContain('/oauth2/applications/@me');
    expect(calls[1]?.url).toContain('/applications/app_1/commands');
    const command = JSON.parse(String(calls[1]?.init.body)) as { name: string; options: { name: string; required: boolean }[]; contexts: number[] };
    expect(command.name).toBe('hive');
    expect(command.options[0]).toMatchObject({ name: 'message', required: true });
    // In a server and in the bot's DMs.
    expect(command.contexts).toEqual([0, 1]);
  });

  it('answers a command in the response, so Discord never says the app did not respond', () => {
    const body = JSON.stringify({
      type: 2, id: 'int_1', channel_id: 'chan_1',
      member: { user: { id: 'u1', username: 'ada' } },
      data: { options: [{ name: 'message', value: 'hello' }] },
    });
    const result = discordAdapter.receive(body, signed(body), context);
    expect(result.kind).toBe('message');
    if (result.kind !== 'message') return;
    expect(result.ack?.contentType).toBe('application/json');
    expect(JSON.parse(result.ack?.body ?? '{}')).toEqual({ type: 4, data: { content: 'On it.' } });
  });

  it('reads a button press, with who pressed and what it carried', () => {
    const body = JSON.stringify({
      type: 3, id: 'int_9', token: 'itok', channel_id: 'chan_1',
      user: { id: 'u1', username: 'ada' },
      message: { id: 'msg_5' },
      data: { custom_id: 'a:apr_1:y' },
    });
    expect(discordAdapter.receive(body, signed(body), context)).toEqual({
      kind: 'choice',
      choice: {
        chatRef: 'chan_1', senderRef: 'u1', senderLabel: '@ada', data: 'a:apr_1:y',
        callbackRef: 'int_9', messageRef: 'msg_5', deliveryRef: 'press:int_9',
      },
    });
  });

  it('settles a press in the response: the message rewritten without its buttons', () => {
    const ack = discordAdapter.ackChoice?.({
      chatRef: 'c', senderRef: 'u', senderLabel: '@u', data: 'd', callbackRef: 'i', messageRef: 'm', deliveryRef: 'press:i',
    }, 'Approved. Carrying on.');
    expect(JSON.parse(ack?.body ?? '{}')).toEqual({ type: 7, data: { content: 'Approved. Carrying on.', components: [] } });
  });

  it('sends the question with buttons and hands back the message', async () => {
    const { impl, calls } = sequence([{ body: { id: 'msg_7' } }]);
    const ref = await discordAdapter.sendChoices?.('tok', 'chan_1', 'Go ahead?', [
      { label: 'Approve', data: 'a:1:y' }, { label: 'Not now', data: 'a:1:n' },
    ], impl);
    expect(ref).toBe('msg_7');
    const sent = JSON.parse(String(calls[0]?.init.body)) as { content: string; components: { components: { label: string; custom_id: string; style: number }[] }[] };
    expect(sent.content).toBe('Go ahead?');
    expect(sent.components[0]?.components.map((b) => [b.label, b.custom_id, b.style])).toEqual([
      ['Approve', 'a:1:y', 1], ['Not now', 'a:1:n', 2],
    ]);
  });

  it('shows a picture as an embed and a clip as its link', async () => {
    const { impl, calls } = sequence([{ body: { id: 'm1' } }, { body: { id: 'm2' } }]);
    await discordAdapter.sendMedia?.('tok', 'chan_1', { kind: 'image', url: 'https://h/i.png' }, impl);
    await discordAdapter.sendMedia?.('tok', 'chan_1', { kind: 'video', url: 'https://h/v.mp4', caption: 'The clip' }, impl);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ embeds: [{ image: { url: 'https://h/i.png' } }] });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ content: 'The clip\nhttps://h/v.mp4' });
  });

  it('types, and survives the empty 204 Discord answers with', async () => {
    const { impl, calls } = sequence([{ status: 204 }]);
    await expect(discordAdapter.indicate?.('tok', 'chan_1', impl)).resolves.toBeUndefined();
    expect(calls[0]?.url).toContain('/channels/chan_1/typing');
  });

  it('posts a draft and rewrites it in place', async () => {
    const { impl, calls } = sequence([{ body: { id: 'm1' } }, { body: { id: 'm1' } }]);
    expect(await discordAdapter.sendDraft?.('tok', 'chan_1', 'Thinking', impl)).toBe('m1');
    await discordAdapter.editDraft?.('tok', 'chan_1', 'm1', 'Done.', impl);
    expect(calls[1]?.url).toContain('/channels/chan_1/messages/m1');
    expect(calls[1]?.init.method).toBe('PATCH');
  });
});

describe('slack as a teammate', () => {
  const secret = 'signing-secret';
  const context = { webhookUrl: 'https://example.test/s', webhookSecret: secret };
  const signed = (body: string, contentType = 'application/json') => {
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
    return new Headers({
      'x-slack-signature': `v0=${digest}`,
      'x-slack-request-timestamp': String(timestamp),
      'content-type': contentType,
    });
  };

  function sequence(answers: readonly unknown[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const answer = answers[n] ?? answers[answers.length - 1] ?? { ok: true };
      n += 1;
      return answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('reads a button press from the form Slack posts, signed over the raw form', () => {
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U1', username: 'ada' },
      channel: { id: 'D1' },
      message: { ts: '1.5' },
      actions: [{ action_id: 'choice_0', value: 'a:apr_1:y' }],
      trigger_id: 'trig_1',
      response_url: 'https://hooks.slack.com/actions/x',
    });
    const body = `payload=${encodeURIComponent(payload)}`;
    expect(slackAdapter.receive(body, signed(body, 'application/x-www-form-urlencoded'), context)).toEqual({
      kind: 'choice',
      choice: {
        chatRef: 'D1', senderRef: 'U1', senderLabel: '@ada', data: 'a:apr_1:y',
        callbackRef: 'https://hooks.slack.com/actions/x', messageRef: '1.5', deliveryRef: 'press:trig_1',
      },
    });
  });

  it('sends the question as blocks with buttons and hands back the ts', async () => {
    const { impl, calls } = sequence([{ ok: true, ts: '2.1' }]);
    const ref = await slackAdapter.sendChoices?.('xoxb', 'D1', 'Go ahead?', [
      { label: 'Approve', data: 'a:1:y' }, { label: 'Not now', data: 'a:1:n' },
    ], impl);
    expect(ref).toBe('2.1');
    const sent = JSON.parse(String(calls[0]?.init.body)) as { blocks: { type: string; elements?: { value: string; style?: string }[] }[] };
    expect(sent.blocks.map((b) => b.type)).toEqual(['section', 'actions']);
    expect(sent.blocks[1]?.elements?.map((e) => [e.value, e.style])).toEqual([['a:1:y', 'primary'], ['a:1:n', undefined]]);
  });

  it('settles a press by rewriting the message without its buttons', async () => {
    const { impl, calls } = sequence([{ ok: true }]);
    await slackAdapter.settleChoice?.('xoxb', {
      chatRef: 'D1', senderRef: 'U1', senderLabel: '@ada', data: 'd', callbackRef: '', messageRef: '1.5', deliveryRef: 'press:t',
    }, 'Approved. Carrying on.', impl);
    expect(calls[0]?.url).toContain('/chat.update');
    const sent = JSON.parse(String(calls[0]?.init.body)) as { ts: string; blocks: { type: string }[] };
    expect(sent.ts).toBe('1.5');
    expect(sent.blocks.map((b) => b.type)).toEqual(['section']);
  });

  it('reads a voice clip, which arrives as a file share', () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message', subtype: 'file_share', channel: 'D1', user: 'U1', text: '', ts: '3.1',
        files: [{ id: 'F1', mimetype: 'audio/mp4', url_private_download: 'https://files.slack.com/f/F1/download', size: 1234, duration_ms: 2500 }],
      },
    });
    expect(slackAdapter.receive(body, signed(body), context)).toEqual({
      kind: 'message',
      message: {
        chatRef: 'D1', senderRef: 'U1', senderLabel: 'U1', text: '', messageRef: '3.1',
        audio: { fileRef: 'https://files.slack.com/f/F1/download', mimeType: 'audio/mp4', durationSeconds: 2.5, sizeBytes: 1234 },
      },
    });
  });

  it('fetches the clip with the bot token, and only from Slack', async () => {
    const { impl, calls } = sequence([new Response(new Uint8Array([1, 2, 3]), { status: 200 })]);
    const bytes = await slackAdapter.fetchAudio?.('xoxb', { fileRef: 'https://files.slack.com/f/F1/download', mimeType: 'audio/mp4' }, impl);
    expect(bytes?.byteLength).toBe(3);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer xoxb');

    await expect(slackAdapter.fetchAudio?.('xoxb', { fileRef: 'https://evil.test/steal', mimeType: 'audio/mp4' }, impl))
      .rejects.toThrow(/not on Slack/);
  });

  it('shows a picture as an image block', async () => {
    const { impl, calls } = sequence([{ ok: true }]);
    await slackAdapter.sendMedia?.('xoxb', 'D1', { kind: 'image', url: 'https://h/i.png', caption: 'The dish' }, impl);
    const sent = JSON.parse(String(calls[0]?.init.body)) as { blocks: { type: string; image_url?: string }[] };
    expect(sent.blocks.map((b) => b.type)).toEqual(['section', 'image']);
    expect(sent.blocks[1]?.image_url).toBe('https://h/i.png');
  });

  it('uploads a clip in Slack\'s three steps so it plays in the channel', async () => {
    const { impl, calls } = sequence([
      new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'content-type': 'video/mp4' } }),
      { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F9' },
      new Response('OK', { status: 200 }),
      { ok: true },
    ]);
    await slackAdapter.sendMedia?.('xoxb', 'D1', { kind: 'video', url: 'https://h/v.mp4', caption: 'The clip' }, impl);
    expect(calls.map((c) => c.url)).toEqual([
      'https://h/v.mp4',
      'https://slack.com/api/files.getUploadURLExternal',
      'https://files.slack.com/upload/v1/abc',
      'https://slack.com/api/files.completeUploadExternal',
    ]);
    // The ticket is asked for as a form, which is the one shape that method takes.
    expect(String(calls[1]?.init.body)).toBe('filename=clip.mp4&length=2');
    expect(JSON.parse(String(calls[3]?.init.body))).toMatchObject({ channel_id: 'D1', files: [{ id: 'F9' }], initial_comment: 'The clip' });
  });

  it('posts a draft and rewrites it in place', async () => {
    const { impl, calls } = sequence([{ ok: true, ts: '4.0' }, { ok: true }]);
    expect(await slackAdapter.sendDraft?.('xoxb', 'D1', 'Thinking', impl)).toBe('4.0');
    await slackAdapter.editDraft?.('xoxb', 'D1', '4.0', 'Done.', impl);
    expect(calls[1]?.url).toContain('/chat.update');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ channel: 'D1', ts: '4.0', text: 'Done.' });
  });
});

describe('whatsapp', () => {
  const appSecret = 'app-secret';
  const context = { webhookUrl: 'https://example.test/w', webhookSecret: appSecret };
  const token = '106540352242922:EAAtoken';
  const signed = (body: string, secret = appSecret) => new Headers({
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  });
  const delivery = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
      contacts: [{ profile: { name: 'Sheena' }, wa_id: '16505551234' }],
      messages: [{ from: '16505551234', id: 'wamid.1', timestamp: '1', ...message }],
      ...extra,
    } }] }],
  });

  function sequence(answers: readonly unknown[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const answer = answers[n] ?? answers[answers.length - 1] ?? {};
      n += 1;
      return answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('composes the phone number id and the access token into one stored token', () => {
    expect(whatsappAdapter.composeToken?.(' EAAtoken ', ' 106540352242922 ')).toBe(token);
  });

  it('identifies the number without the token in the URL', async () => {
    const { impl, calls } = sequence([{ display_phone_number: '+1 555-078-3881', verified_name: 'Lucky Shrub', id: '106540352242922' }]);
    const who = await whatsappAdapter.identify(token, impl);
    expect(who).toEqual({ handle: '+1 555-078-3881', displayName: 'Lucky Shrub', botRef: '106540352242922' });
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v22.0/106540352242922?fields=display_phone_number,verified_name');
    expect(calls[0]?.url).not.toContain('EAAtoken');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer EAAtoken');
  });

  it("answers Meta's probe with the challenge when the verify token is its own", () => {
    const verifyToken = whatsappVerifyToken(context);
    const good = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': '1158201444' });
    expect(whatsappAdapter.verify?.(good, context)).toEqual({ body: '1158201444', contentType: 'text/plain' });
    const bad = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'meatyhamhock', 'hub.challenge': '1' });
    expect(whatsappAdapter.verify?.(bad, context)).toBeUndefined();
    // Derived, so two connections with different app secrets have different tokens.
    expect(whatsappVerifyToken({ ...context, webhookSecret: 'other' })).not.toBe(verifyToken);
  });

  it('rejects an unsigned delivery and one signed with another app secret', () => {
    const body = delivery({ type: 'text', text: { body: 'hi' } });
    expect(whatsappAdapter.receive(body, new Headers(), context).kind).toBe('rejected');
    expect(whatsappAdapter.receive(body, signed(body, 'wrong'), context).kind).toBe('rejected');
  });

  it('reads a text message, named after the contact', () => {
    const body = delivery({ type: 'text', text: { body: 'Does it come in another color?' } });
    expect(whatsappAdapter.receive(body, signed(body), context)).toEqual({
      kind: 'message',
      message: { chatRef: '16505551234', senderRef: '16505551234', senderLabel: 'Sheena', text: 'Does it come in another color?', messageRef: 'wamid.1' },
    });
  });

  it('ignores a status update, which is about a message of ours', () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '1' }, statuses: [{ id: 'wamid.9', status: 'delivered' }],
    } }] }] });
    expect(whatsappAdapter.receive(body, signed(body), context)).toEqual({ kind: 'ignored', reason: 'A status update, not a message.' });
  });

  it('reads a button tap, with the message the button was on', () => {
    const body = delivery({ type: 'interactive', context: { id: 'wamid.q' }, interactive: { type: 'button_reply', button_reply: { id: 'a:apr_1:y', title: 'Approve' } } });
    expect(whatsappAdapter.receive(body, signed(body), context)).toEqual({
      kind: 'choice',
      choice: { chatRef: '16505551234', senderRef: '16505551234', senderLabel: 'Sheena', data: 'a:apr_1:y', callbackRef: 'wamid.1', messageRef: 'wamid.q', deliveryRef: 'press:wamid.1' },
    });
  });

  it('reads a voice note as audio to fetch', () => {
    const body = delivery({ type: 'audio', audio: { id: 'media_7', mime_type: 'audio/ogg; codecs=opus', voice: true } });
    expect(whatsappAdapter.receive(body, signed(body), context)).toMatchObject({
      kind: 'message', message: { text: '', audio: { fileRef: 'media_7', mimeType: 'audio/ogg; codecs=opus' } },
    });
  });

  it('sends text to the number from the number', async () => {
    const { impl, calls } = sequence([{ messages: [{ id: 'wamid.s' }] }]);
    await whatsappAdapter.send(token, '16505551234', 'Hello', impl);
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v22.0/106540352242922/messages');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '16505551234', type: 'text', text: { body: 'Hello', preview_url: true },
    });
  });

  it('asks with reply buttons, at most three, labels cut to twenty characters', async () => {
    const { impl, calls } = sequence([{ messages: [{ id: 'wamid.b' }] }]);
    const ref = await whatsappAdapter.sendChoices?.(token, '16505551234', 'Go ahead?', [
      { label: 'Approve', data: 'a:1:y' }, { label: 'Not now, maybe later this week', data: 'a:1:n' },
    ], impl);
    expect(ref).toBe('wamid.b');
    const sent = JSON.parse(String(calls[0]?.init.body)) as { type: string; interactive: { type: string; body: { text: string }; action: { buttons: { reply: { id: string; title: string } }[] } } };
    expect(sent.type).toBe('interactive');
    expect(sent.interactive.body.text).toBe('Go ahead?');
    expect(sent.interactive.action.buttons.map((b) => [b.reply.id, b.reply.title])).toEqual([['a:1:y', 'Approve'], ['a:1:n', 'Not now, maybe later']]);
  });

  it('sends a picture and a clip by link', async () => {
    const { impl, calls } = sequence([{ messages: [{ id: '1' }] }, { messages: [{ id: '2' }] }]);
    await whatsappAdapter.sendMedia?.(token, '16505551234', { kind: 'image', url: 'https://h/i.png', caption: 'The dish' }, impl);
    await whatsappAdapter.sendMedia?.(token, '16505551234', { kind: 'video', url: 'https://h/v.mp4' }, impl);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ type: 'image', image: { link: 'https://h/i.png', caption: 'The dish' } });
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ type: 'video', video: { link: 'https://h/v.mp4' } });
  });

  it('marks the message read and types, only when it knows which message', async () => {
    const { impl, calls } = sequence([{ success: true }]);
    await whatsappAdapter.indicate?.(token, '16505551234', impl);
    expect(calls).toHaveLength(0);
    await whatsappAdapter.indicate?.(token, '16505551234', impl, 'wamid.1');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.1', typing_indicator: { type: 'text' },
    });
  });

  it('fetches a recording in two steps and sends the token only to Meta', async () => {
    const { impl, calls } = sequence([
      { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'audio/ogg', file_size: 1234 },
      new Response(new Uint8Array([1, 2]), { status: 200 }),
    ]);
    const bytes = await whatsappAdapter.fetchAudio?.(token, { fileRef: 'media_7', mimeType: 'audio/ogg' }, impl);
    expect(bytes?.byteLength).toBe(2);
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v22.0/media_7');
    expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe('Bearer EAAtoken');

    const elsewhere = sequence([{ url: 'https://evil.test/steal', mime_type: 'audio/ogg', file_size: 1 }]);
    await expect(whatsappAdapter.fetchAudio?.(token, { fileRef: 'media_7', mimeType: 'audio/ogg' }, elsewhere.impl)).rejects.toThrow(/not on Meta/);
  });

  it("says Meta's 24-hour rule in words a person can act on", async () => {
    const { impl } = sequence([new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), { status: 400 })]);
    await expect(whatsappAdapter.send(token, '16505551234', 'Hello', impl)).rejects.toThrow(/within 24 hours/);
  });
});

describe('imessage, through a Mac of your own', () => {
  const token = 'https://quiet-river.trycloudflare.com s3cret';
  const context = { webhookUrl: 'https://example.test/api/channels/imessage/ch_1', webhookSecret: '' };
  const message = (over: Record<string, unknown> = {}) => ({
    guid: 'msg_1', text: 'what is on my calendar', isFromMe: false,
    handle: { address: '+15551234567' }, chats: [{ guid: 'iMessage;-;+15551234567' }], attachments: [], ...over,
  });
  const event = (data: unknown, type = 'new-message') => JSON.stringify({ type, data });

  function sequence(answers: readonly unknown[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const answer = answers[n] ?? answers[answers.length - 1] ?? {};
      n += 1;
      return answer instanceof Response ? answer : new Response(JSON.stringify({ status: 200, message: 'Success', data: answer }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('composes the address and the password, and refuses an address that is not a URL', async () => {
    expect(imessageAdapter.composeToken?.('s3cret', 'https://quiet-river.trycloudflare.com/')).toBe('https://quiet-river.trycloudflare.com/ s3cret');
    await expect(imessageAdapter.identify('not-a-url s3cret', sequence([{}]).impl)).rejects.toThrow(/should be a URL/);
  });

  it('identifies the Mac by the account Messages is signed in as, with the password in the query where the server looks', async () => {
    const { impl, calls } = sequence([{ detected_imessage: 'assistant@icloud.com', os_version: '15.1', server_version: '1.9.9' }]);
    const who = await imessageAdapter.identify(token, impl);
    expect(who).toEqual({ handle: 'assistant@icloud.com', displayName: 'Messages, signed in as assistant@icloud.com', botRef: 'assistant@icloud.com' });
    expect(calls[0]?.url).toBe('https://quiet-river.trycloudflare.com/api/v1/server/info?password=s3cret');
  });

  it('tells the Mac where to post new messages, once', async () => {
    const fresh = sequence([[], { id: 1 }]);
    await imessageAdapter.register(token, context, fresh.impl);
    expect(fresh.calls.map((c) => c.init.method ?? 'GET')).toEqual(['GET', 'POST']);
    expect(JSON.parse(String(fresh.calls[1]?.init.body))).toEqual({ url: context.webhookUrl, events: ['new-message'] });

    const already = sequence([[{ id: 1, url: context.webhookUrl }]]);
    await imessageAdapter.register(token, context, already.impl);
    expect(already.calls).toHaveLength(1);
  });

  it('reads a new message from the person', () => {
    const body = event(message());
    expect(imessageAdapter.receive(body, new Headers(), context)).toEqual({
      kind: 'message',
      message: { chatRef: 'iMessage;-;+15551234567', senderRef: '+15551234567', senderLabel: '+15551234567', text: 'what is on my calendar', messageRef: 'msg_1' },
    });
  });

  it('ignores its own replies, group chats and other events', () => {
    expect(imessageAdapter.receive(event(message({ isFromMe: true })), new Headers(), context).kind).toBe('ignored');
    expect(imessageAdapter.receive(event(message({ chats: [{ guid: 'iMessage;+;chat123' }] })), new Headers(), context).kind).toBe('ignored');
    expect(imessageAdapter.receive(event(message(), 'typing-indicator'), new Headers(), context).kind).toBe('ignored');
  });

  it('reads a voice memo, to be fetched as mp3', () => {
    const body = event(message({ text: '￼', attachments: [{ guid: 'att_1', mimeType: 'audio/x-caf', totalBytes: 5000 }] }));
    expect(imessageAdapter.receive(body, new Headers(), context)).toMatchObject({
      kind: 'message', message: { text: '', audio: { fileRef: 'att_1', mimeType: 'audio/mpeg', sizeBytes: 5000 } },
    });
  });

  it('believes a delivery only once the Mac confirms the message', async () => {
    const inbound = { chatRef: 'iMessage;-;+15551234567', senderRef: '+15551234567', senderLabel: '+15551234567', text: 'what is on my calendar', messageRef: 'msg_1' };
    const real = sequence([message()]);
    expect(await imessageAdapter.confirm?.(token, inbound, real.impl)).toBe(true);
    expect(real.calls[0]?.url).toBe('https://quiet-river.trycloudflare.com/api/v1/message/msg_1?with=chats&password=s3cret');

    const forged = sequence([message({ text: 'something else' })]);
    expect(await imessageAdapter.confirm?.(token, inbound, forged.impl)).toBe(false);
    const missing = sequence([new Response(JSON.stringify({ status: 404, message: 'Not found' }), { status: 404 })]);
    expect(await imessageAdapter.confirm?.(token, inbound, missing.impl)).toBe(false);
  });

  it('sends a reply into the chat', async () => {
    const { impl, calls } = sequence([message({ isFromMe: true })]);
    await imessageAdapter.send(token, 'iMessage;-;+15551234567', 'Two meetings.', impl);
    expect(calls[0]?.url).toBe('https://quiet-river.trycloudflare.com/api/v1/message/text?password=s3cret');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ chatGuid: 'iMessage;-;+15551234567', message: 'Two meetings.', method: 'apple-script' });
  });

  it('sends a picture as an attachment, then its caption', async () => {
    const { impl, calls } = sequence([
      new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'image/png' } }),
      message({ isFromMe: true }),
      message({ isFromMe: true }),
    ]);
    await imessageAdapter.sendMedia?.(token, 'iMessage;-;+15551234567', { kind: 'image', url: 'https://h/i.png', caption: 'The dish' }, impl);
    expect(calls.map((c) => c.url)).toEqual([
      'https://h/i.png',
      'https://quiet-river.trycloudflare.com/api/v1/message/attachment?password=s3cret',
      'https://quiet-river.trycloudflare.com/api/v1/message/text?password=s3cret',
    ]);
    expect(calls[1]?.init.body).toBeInstanceOf(FormData);
    expect((calls[1]?.init.body as FormData).get('chatGuid')).toBe('iMessage;-;+15551234567');
  });

  it('fetches a recording from the Mac', async () => {
    const { impl, calls } = sequence([new Response(new Uint8Array([1, 2, 3]), { status: 200 })]);
    const bytes = await imessageAdapter.fetchAudio?.(token, { fileRef: 'att_1', mimeType: 'audio/mpeg' }, impl);
    expect(bytes?.byteLength).toBe(3);
    expect(calls[0]?.url).toBe('https://quiet-river.trycloudflare.com/api/v1/attachment/att_1/download?password=s3cret');
  });
});
