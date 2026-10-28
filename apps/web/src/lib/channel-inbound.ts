/**
 * Turning a chat message into a run.
 *
 * The order of operations here is the whole of the correctness argument, so it
 * is worth stating:
 *
 *  1. Find the connection. By id from the URL — the platform knows nothing
 *     about workspaces, and a workspace id in a webhook URL would publish the
 *     tenant boundary to anyone who glanced at it.
 *  2. Let the adapter judge the delivery. It holds the platform's own
 *     authentication, and nothing below runs until it has passed.
 *  3. Claim the delivery. A unique index makes a redelivery a no-op. Every one
 *     of these platforms retries a slow request, and this is what stops a
 *     timeout from answering twice.
 *  4. Then, and only then, write.
 *
 * A connection that has not completed its ownership handshake answers only the
 * handshake. That is what stops somebody who has obtained a bot token from
 * using somebody else's agent, budget and credentials.
 */
import { ChannelRepository, ConversationRepository, AgentRepository, PlatformDb } from '@salvations/db';
import { linkFromChat } from './chat-link';
import { decideFromChat } from './channel-approvals';
import { spendGate } from './limits';
import type { ChannelDoc } from '@salvations/db';
import {
  channelAdapter, discordGuildOf, slackTeamOf, telegramChatOf, whatsappPhoneOf, NOT_IN_SERVER,
  type Ack, type ChannelAdapter, type InboundMessage, type InboundResult, type VerifyContext,
} from '@salvations/channels';
import { NO_EAR, transcribeAudio } from './transcribe';
import { deliveredToOldAddress, registerWebhook, webhookUrl, WEBHOOK_SPEC } from './channel-webhook';
import { slackApp, slackAppWebhookUrl } from './slack-app';
import { discordApp, discordAppWebhookUrl } from './discord-app';
import { answerSharedProbe, whatsappAppWebhookUrl, whatsappSignup } from './whatsapp-signup';
import { telegramAppWebhookUrl, telegramBot } from './telegram-bot';
import {
  DEFAULT_BUDGET, asId, type RunId, type UserId, type WorkspaceId,
} from '@salvations/core';
import { db } from './db';
import { repositories } from './container';
import { VercelBackgroundTrigger } from './trigger';
import { agentSnapshotFor } from '@/lib/agent-snapshot';
import { modelForAgent } from './agent-model';

/** How long a connect code is worth trying. Long enough to find the app. */
export const CONNECT_CODE_TTL_MS = 30 * 60 * 1000;

export interface DeliveryOutcome {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

const plain = (status: number, body: string): DeliveryOutcome =>
  ({ status, body, contentType: 'text/plain' });

/**
 * Where a platform delivers to this deployment.
 *
 * One definition, because it is shown to the person during setup AND registered
 * with the platform, and a mismatch between the two produces a connection that
 * looks configured and receives nothing.
 */
export { webhookUrl } from './channel-webhook';

export async function handleDelivery(
  type: string,
  channelDocId: string,
  raw: string,
  headers: Headers,
): Promise<DeliveryOutcome> {
  const adapter = channelAdapter(type);
  if (adapter === undefined) return plain(404, 'unknown channel');

  const handle = await db();
  // Unscoped by necessity and by declaration: the URL names a connection, not
  // a tenant. Everything after this line is scoped to the workspace it names.
  const platform = new PlatformDb(handle.db, 'channel-delivery');
  const row = await platform
    .collection<ChannelDoc>('channels')
    .findOne({ _id: channelDocId, type } as never, { comment: platform.comment });

  // The same answer for "no such connection" and "wrong platform": a webhook
  // URL is a public string, and confirming which ids exist helps only someone
  // enumerating them.
  if (row === null) return plain(404, 'unknown channel');

  const repos = repositories(handle.db, row.workspaceId);

  const secret = row.secretCredentialId === null || row.secretCredentialId === undefined
    ? undefined
    : await repos.credentials.resolve(row.secretCredentialId);

  const context: VerifyContext = {
    webhookUrl: webhookUrl(type, channelDocId),
    webhookSecret: secret?.expose() ?? '',
  };

  const judged = adapter.receive(raw, headers, context);

  // Delivered to an address this deployment no longer calls its own: the
  // site moved. The bot is re-pointed now, on the strength of a delivery the
  // platform signed, so the next message arrives at the new address without
  // anyone having to notice.
  //
  // The same when the registration predates what this deployment asks the
  // platform for: a bot registered before button presses were asked for
  // never hears a press, and the person sees a button that does nothing.
  const stale = deliveredToOldAddress(headers) || (row.webhookSpec ?? 1) !== WEBHOOK_SPEC;
  if (judged.kind !== 'rejected' && stale) {
    await registerWebhook(handle.db, row).catch((caught: unknown) => {
      console.log(JSON.stringify({ at: 'channel-inbound', channel: row._id, webhook: 'refresh_failed', error: caught instanceof Error ? caught.message : String(caught) }));
    });
  }

  return act(handle.db, row, adapter, judged);
}

/**
 * A delivery to the address shared by every workspace that installed this
 * deployment's own app.
 *
 * Slack holds one request URL per app, so a workspace that pressed "Add to
 * Slack" cannot be given an address of its own. The app's one signing
 * secret authenticates the delivery, and the workspace id inside it says
 * which connection it is for. A workspace nobody connected is acknowledged
 * and ignored: an error would make Slack retry, and then give up on the
 * app for everyone.
 */
export async function handleSharedDelivery(type: string, raw: string, headers: Headers): Promise<DeliveryOutcome> {
  const shared = await sharedAppOf(type);
  const adapter = channelAdapter(type);
  if (shared === undefined || adapter === undefined) return plain(404, 'unknown channel');

  const judged = adapter.receive(raw, headers, { webhookUrl: shared.webhookUrl, webhookSecret: shared.webhookSecret });
  if (judged.kind === 'rejected') return plain(401, 'unauthorized');
  if (judged.kind === 'challenge') return { status: 200, body: judged.body, contentType: judged.contentType };
  if (judged.kind === 'ignored') return plain(200, 'ok');

  const teamRef = shared.teamOf(raw);
  if (teamRef === undefined) {
    // Somewhere the shared application cannot place: a DM with a Discord
    // bot. Said in the response where the platform shows one.
    return shared.notHere === undefined ? plain(200, 'ok') : { status: 200, body: shared.notHere.body, contentType: shared.notHere.contentType };
  }

  const handle = await db();
  // Unscoped by declaration: the delivery names Slack's workspace, and which
  // of ours that maps to is exactly the question.
  const platform = new PlatformDb(handle.db, 'channel-delivery');
  const row = await platform
    .collection<ChannelDoc>('channels')
    .findOne({ type, 'install.teamRef': teamRef, status: { $ne: 'disabled' } } as never, { comment: platform.comment });
  if (row === null) {
    // A chat nobody has connected. For the shared Telegram bot this is how
    // every connection begins: the first message carries the code the
    // person was shown, and binding happens here.
    if (shared.claimBy !== undefined && judged.kind === 'message') {
      return await shared.claimBy(handle.db, teamRef, judged.message, adapter);
    }
    console.log(JSON.stringify({ at: 'channel-inbound', shared: type, team: teamRef, outcome: 'no_connection' }));
    return plain(200, 'ok');
  }

  return act(handle.db, row, adapter, judged);
}

/**
 * The first hello to the shared Telegram bot from a chat nobody has
 * connected: the code in it names a connection waiting for its chat, in
 * whichever workspace, and the chat is bound to that one. Anything else is
 * answered with how to connect, so a stranger talking to the bot is told
 * what it is rather than ignored.
 */
async function claimTelegramChat(
  database: Awaited<ReturnType<typeof db>>['db'],
  chatRef: string,
  message: InboundMessage,
  adapter: ChannelAdapter,
): Promise<DeliveryOutcome> {
  const bot = await telegramBot();
  if (bot === undefined) return plain(200, 'ok');
  const say = async (text: string) => { await adapter.send(bot.token, chatRef, text).catch(() => undefined); };

  const offered = offeredCode(message.text);
  const platform = new PlatformDb(database, 'channel-delivery');
  const waiting = /^[A-Z0-9]{6,12}$/.test(offered)
    ? await platform.collection<ChannelDoc>('channels').findOne({
      type: 'telegram', 'connect.code': offered, 'connect.expiresAt': { $gt: new Date() }, install: { $ne: null },
    } as never, { comment: platform.comment })
    : null;
  if (waiting === null) {
    await say('Hello. I am an assistant on YASHAYAH. To connect this chat, press Connect Telegram in YASHAYAH and send me the code it shows.');
    return plain(200, 'ok');
  }

  const channels = new ChannelRepository(database, waiting.workspaceId);
  const claimed = await channels.claim(waiting._id, offered, chatRef);
  if (claimed === null) {
    await say('That code is not right, or it has expired. Open YASHAYAH for a new one.');
    return plain(200, 'ok');
  }
  await channels.bindInstall(waiting._id, chatRef, message.senderLabel);
  await channels.recordWebhook(waiting._id, telegramAppWebhookUrl(), WEBHOOK_SPEC);
  await say('Connected. This chat is yours now. Say anything and your assistant will answer.');
  console.log(JSON.stringify({ at: 'channel-inbound', shared: 'telegram', channel: waiting._id, outcome: 'claimed' }));
  return plain(200, 'ok');
}

interface SharedApp {
  readonly webhookUrl: string;
  /** What the adapter verifies deliveries with: Slack's signing secret, Discord's public key. */
  readonly webhookSecret: string;
  /** The platform's id for the workspace or server a delivery came from. */
  readonly teamOf: (raw: string) => string | undefined;
  /** The answer when a delivery names no workspace at all, where the platform shows one. */
  readonly notHere?: Ack;
  /** For a bot whose connections begin with a message: what to do with a chat nobody has connected. */
  readonly claimBy?: (database: Awaited<ReturnType<typeof db>>['db'], teamRef: string, message: InboundMessage, adapter: ChannelAdapter) => Promise<DeliveryOutcome>;
}

/** The deployment's own application for a platform, when it has one. */
async function sharedAppOf(type: string): Promise<SharedApp | undefined> {
  if (type === 'slack') {
    const app = await slackApp();
    return app === undefined ? undefined : { webhookUrl: slackAppWebhookUrl(), webhookSecret: app.signingSecret, teamOf: slackTeamOf };
  }
  if (type === 'discord') {
    const app = await discordApp();
    return app === undefined ? undefined : { webhookUrl: discordAppWebhookUrl(), webhookSecret: app.publicKey, teamOf: discordGuildOf, notHere: NOT_IN_SERVER };
  }
  if (type === 'whatsapp') {
    const signup = await whatsappSignup();
    return signup === undefined ? undefined : { webhookUrl: whatsappAppWebhookUrl(), webhookSecret: signup.appSecret, teamOf: whatsappPhoneOf };
  }
  if (type === 'telegram') {
    const bot = await telegramBot();
    return bot === undefined ? undefined : { webhookUrl: telegramAppWebhookUrl(), webhookSecret: bot.webhookSecret, teamOf: telegramChatOf, claimBy: claimTelegramChat };
  }
  return undefined;
}

/**
 * Meta's GET probe on the shared WhatsApp address, before it will save it:
 * the challenge is echoed when the verify token matches. Other platforms
 * do not probe the shared address with a GET; a 200 is enough for them.
 */
export async function handleSharedProbe(type: string, query: URLSearchParams): Promise<DeliveryOutcome> {
  if (type !== 'whatsapp') return plain(200, 'ok');
  const signup = await whatsappSignup();
  if (signup === undefined) return plain(404, 'unknown channel');
  const challenge = answerSharedProbe(signup, query);
  return challenge === undefined ? plain(403, 'forbidden') : plain(200, challenge);
}

/**
 * What happens once a delivery has been authenticated and its connection
 * found. The same for an address of the connection's own and for the shared
 * one: from here the platform's workspace is forgotten and ours is all that
 * matters.
 */
async function act(
  database: Awaited<ReturnType<typeof db>>['db'],
  row: ChannelDoc,
  adapter: ChannelAdapter,
  judged: InboundResult,
): Promise<DeliveryOutcome> {
  const handle = { db: database };
  const repos = repositories(handle.db, row.workspaceId);
  const channels = new ChannelRepository(handle.db, row.workspaceId);

  switch (judged.kind) {
    case 'rejected':
      // 401, not 400: it is an authentication failure, and a platform that gets
      // 400 concludes its payload is malformed and keeps sending it.
      return plain(401, 'unauthorized');

    case 'challenge':
      return { status: 200, body: judged.body, contentType: judged.contentType };

    case 'ignored':
      // 200. A platform that receives an error for its own liveness ping or for
      // a sticker will disable the webhook, which is a far worse outcome than
      // acknowledging something we chose not to act on.
      return plain(200, 'ok');

    case 'choice': {
      // A press on one of our buttons: an approval decided from the chat.
      // Claimed like a message, so a redelivered press cannot decide twice.
      const choice = judged.choice;
      if (!await channels.claimDelivery(row._id, choice.deliveryRef)) return plain(200, 'ok');
      if (row.status !== 'connected') return plain(200, 'ok');
      const outcome = await decideFromChat({ database: handle.db, workspaceId: row.workspaceId, channelId: row._id, choice, repos });
      console.log(JSON.stringify({ at: 'channel-inbound', channel: row._id, press: outcome.decided ? 'decided' : 'refused' }));
      // A platform that reads the response as the answer to the press gets
      // the rewritten message there, in one round trip.
      if (adapter.ackChoice !== undefined) {
        const ack = adapter.ackChoice(choice, outcome.text);
        return { status: 200, body: ack.body, contentType: ack.contentType };
      }
      const token = await repos.credentials.resolve(row.tokenCredentialId);
      if (token !== null) {
        if (adapter.settleChoice !== undefined) {
          await adapter.settleChoice(token.expose(), choice, outcome.text).catch(() => undefined);
        } else {
          await adapter.send(token.expose(), choice.chatRef, outcome.text).catch(() => undefined);
        }
      }
      return plain(200, 'ok');
    }

    case 'message':
      break;
  }

  const message = judged.message;

  // A platform that cannot sign is asked whether the message is real
  // before anything is written. Answered 401 like a bad signature: it is
  // the same failure by another route.
  if (adapter.confirm !== undefined) {
    const token = await repos.credentials.resolve(row.tokenCredentialId);
    const real = token !== null && await adapter.confirm(token.expose(), message);
    if (!real) return plain(401, 'unauthorized');
  }

  // What the platform is told once the message is in hand. Discord shows
  // this response under the command, so it is a word rather than "ok".
  const done: DeliveryOutcome = judged.ack === undefined
    ? plain(200, 'ok')
    : { status: 200, body: judged.ack.body, contentType: judged.ack.contentType };

  // A redelivery. Acknowledged so the platform stops retrying, and not acted
  // on, because somebody already did.
  if (!await channels.claimDelivery(row._id, message.messageRef)) {
    return done;
  }

  await channels.recordDelivery(row._id);

  /*
   * From here on the delivery is claimed, and the claim is what makes a
   * redelivery a no-op. So anything that fails below has to GIVE THE CLAIM
   * BACK before the error escapes: a claim held over failed work turns the
   * platform's retry — the one mechanism that could still save this message —
   * into a silent drop, and the person is left watching a chat that never
   * answers.
   */
  try {
    if (row.status !== 'connected') {
      await completeHandshake(channels, row, message, repos);
      return done;
    }

    // The connection is bound to ONE chat. A bot token that has leaked is a bot
    // anybody can message; without this, the leak becomes free use of this
    // workspace's model budget and every credential its agent can reach.
    if (row.verifiedChatRef !== null && row.verifiedChatRef !== message.chatRef) {
      await reply(row, message.chatRef, 'This bot is already connected to another chat.', repos);
      return done;
    }

    // A link code is answered and goes no further: it is not a message for
    // the assistant, and a run on it would be a run on a password.
    const link = await linkFromChat({ database: handle.db, row, message, channels });
    if (link !== undefined) {
      await reply(row, message.chatRef, link.text, repos);
      console.log(JSON.stringify({ at: 'channel-inbound', channel: row._id, link: link.linked ? 'linked' : 'refused' }));
      return done;
    }

    /*
     * A voice note becomes words before anything else happens.
     *
     * The transcript is sent back to the person first. Transcription is the
     * one step here that can silently substitute something they did not say,
     * and they are the only one who can catch it — so it is shown at the
     * moment it happens rather than discovered three replies later when the
     * answer makes no sense.
     */
    const heard = await hear(handle.db, row, message, repos);
    if (heard === undefined) return done;

    // "typing…" from the moment the message lands, so the wait for the
    // executor to pick the run up is not a silence. The executor keeps it up.
    await indicateTyping(row, message.chatRef, repos, message.messageRef);

    const runId = await startRun(handle.db, row, heard, repos, channels);
    if (runId !== undefined) await channels.attachRun(row._id, message.messageRef, runId);
    console.log(JSON.stringify({
      at: 'channel-inbound', channel: row._id, ...(runId !== undefined ? { runId } : { started: false }),
    }));

    return done;
  } catch (caught) {
    await channels.releaseDelivery(row._id, message.messageRef).catch(() => undefined);
    await channels.recordFailure(
      row._id, caught instanceof Error ? caught.message : String(caught),
    ).catch(() => undefined);
    // Rethrown so the response is a 500 and the platform retries. Answering 200
    // here would tell it the message was handled.
    throw caught;
  }
}

type Repos = ReturnType<typeof repositories>;

/**
 * The ownership handshake.
 *
 * Until it completes, the connection answers nothing but this. The code is
 * matched and cleared in a single write, so a code cannot be used twice and two
 * simultaneous attempts cannot both win.
 */
async function completeHandshake(
  channels: ChannelRepository,
  row: ChannelDoc,
  message: InboundMessage,
  repos: Repos,
): Promise<void> {
  const offered = offeredCode(message.text);
  const claimed = await channels.claim(row._id, offered, message.chatRef);

  if (claimed === null) {
    await reply(
      row, message.chatRef,
      'That code is not right, or it has expired. Open the integrations page for a new one.',
      repos,
    );
    return;
  }

  await reply(
    row, message.chatRef,
    'Connected. This chat is yours now — say anything and your agent will answer.',
    repos,
  );
}

/**
 * Appends the message and queues a run.
 *
 * The conversation is found by the sender's platform id, so a person keeps one
 * thread rather than starting a new one every time they say something.
 */
async function startRun(
  database: Awaited<ReturnType<typeof db>>['db'],
  row: ChannelDoc,
  message: InboundMessage,
  repos: Repos,
  channels: ChannelRepository,
): Promise<string | undefined> {
  const agent = await new AgentRepository(database, row.workspaceId).findById(row.agentId);
  if (agent === null) {
    await reply(row, message.chatRef, 'This connection has no agent any more.', repos);
    return undefined;
  }

  /*
   * Which model answers.
   *
   * The channel may pin one, but normally does not: the agent names a ROLE and
   * the workspace maps roles to bindings, so following the role means changing
   * vendor is one edit rather than one per channel.
   *
   * Resolving here rather than at connect time is also what lets somebody set
   * up Telegram before they have an API key — but it means the role can come
   * back unmapped, and that has to be said out loud rather than becoming a run
   * that fails somewhere the person cannot see it.
   */
  const binding = row.modelBindingId !== null && row.modelBindingId !== undefined
    ? await repos.models.findById(row.modelBindingId)
    : await modelForAgent(repos.models, agent);

  if (binding === null) {
    await reply(
      row, message.chatRef,
      'I am connected, but no model is set up for me to think with yet. '
      + 'Add one on the Models page and try again.',
      repos,
    );
    return undefined;
  }

  // A cap reached is said in the chat, in the same words the web app uses.
  const gate = await spendGate(database, row.workspaceId, { modelBindingId: binding._id });
  if (!gate.allowed) {
    await reply(row, message.chatRef, `I can't take this on right now. ${gate.reason ?? ''}`.trim(), repos);
    return undefined;
  }

  const conversations = new ConversationRepository(database, row.workspaceId);
  const existing = await channels.findIdentity(row._id, message.senderRef);

  let conversationId = existing?.conversationId;
  if (conversationId === undefined) {
    const created = await conversations.create({
      agentId: row.agentId,
      modelBindingId: binding._id,
      title: `${message.senderLabel} on ${row.type}`,
      channelId: row._id,
      externalRef: message.chatRef,
    });
    conversationId = created._id;
  }

  const identity = await channels.linkIdentity({
    channelId: row._id,
    externalUserId: message.senderRef,
    chatRef: message.chatRef,
    conversationId,
    label: message.senderLabel,
  });

  await conversations.appendMessage({
    conversationId,
    role: 'user',
    content: [{ type: 'text', text: message.text }],
    // The platform's own message id. A retry that slips past the delivery claim
    // still collides here rather than appending the same sentence twice.
    clientMessageId: `${row._id}:${message.messageRef}`,
  });

  const run = await repos.runs.create({
    conversationId,
    agentId: row.agentId,
    agentVersionId: agent.currentVersion.versionId,
    agentSnapshot: await agentSnapshotFor(database, row.workspaceId, row.agentId, agent.currentVersion),
    modelBindingId: binding._id,
    trigger: { type: 'channel', ref: `${row.type}:${message.senderRef}` },
    /*
     * A platform id identifies somebody; it does not entitle them to anything.
     * `trust: 'unlinked'` says exactly that — this is a Telegram account that
     * has proved it can reach the bot and nothing more. It becomes 'linked'
     * only when the platform account is tied to a YASHAYAH account, and until then
     * policy can treat it as the stranger it is.
     */
    principal: {
      type: 'channel_identity',
      identityId: identity._id,
      workspaceId: asId<WorkspaceId>(row.workspaceId),
      trust: identity.userId === null || identity.userId === undefined ? 'unlinked' : 'linked',
      ...(identity.userId !== null && identity.userId !== undefined
        ? { userId: asId<UserId>(identity.userId) }
        : {}),
    },
    budget: DEFAULT_BUDGET,
  });

  await new VercelBackgroundTrigger().trigger(asId<RunId>(run._id));
  return run._id;
}


/**
 * Resolves a message to the words it contains.
 *
 * Returns undefined when there is nothing to answer — the person has already
 * been told why, and starting a run on an empty message would produce an agent
 * replying to silence.
 */
async function hear(
  database: Awaited<ReturnType<typeof db>>['db'],
  row: ChannelDoc,
  message: InboundMessage,
  repos: Repos,
): Promise<InboundMessage | undefined> {
  if (message.audio === undefined) return message;

  const adapter = channelAdapter(row.type);
  if (adapter?.fetchAudio === undefined) {
    await reply(row, message.chatRef, 'I cannot fetch recordings on this platform yet.', repos);
    return undefined;
  }

  const token = await repos.credentials.resolve(row.tokenCredentialId);
  if (token === null) {
    await reply(row, message.chatRef, 'I could not reach that recording.', repos);
    return undefined;
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await adapter.fetchAudio(token.expose(), message.audio);
  } catch (caught) {
    await reply(
      row, message.chatRef,
      caught instanceof Error ? caught.message : 'I could not download that recording.',
      repos,
    );
    return undefined;
  }

  const outcome = await transcribeAudio(database, row.workspaceId, message.audio, bytes);

  if (outcome.kind === 'unconfigured') {
    await reply(row, message.chatRef, NO_EAR, repos);
    return undefined;
  }

  if (outcome.kind === 'failed') {
    console.log(JSON.stringify({ at: 'channel-inbound', channel: row._id, transcription: 'failed', detail: outcome.detail ?? outcome.message }));
    await reply(row, message.chatRef, outcome.message, repos);
    return undefined;
  }

  // Shown back before the answer. Quoted so it reads as a repetition of what
  // was heard rather than as the agent speaking.
  await reply(row, message.chatRef, `\u201c${outcome.text}\u201d`, repos);

  // A caption alongside the recording is also something the person said, so it
  // is kept rather than replaced.
  const typed = message.text.trim();
  return {
    ...message,
    text: typed === '' ? outcome.text : `${typed}\n\n${outcome.text}`,
  };
}

/** Says something back. Never throws — a failed reply must not retry the run. */
async function reply(
  row: ChannelDoc,
  chatRef: string,
  text: string,
  repos: Repos,
): Promise<void> {
  const adapter = channelAdapter(row.type);
  if (adapter === undefined) return;
  try {
    const token = await repos.credentials.resolve(row.tokenCredentialId);
    if (token === null) return;
    await adapter.send(token.expose(), chatRef, text);
  } catch {
    // Swallowed on purpose. The platform is waiting on this response, and
    // turning "could not reach Telegram" into a 500 makes it retry the whole
    // delivery — which would start the run again.
  }
}

/**
 * The code as the person sent it.
 *
 * Telegram's deep link delivers it as `/start <code>` — that is what the QR
 * code and the "Open @bot" button send — and a person typing it sends the
 * bare code. Both are the same proof, so both match. Only the last word is
 * taken, so "here is the code ABCD2345" still works.
 */
export function offeredCode(text: string): string {
  const words = text.trim().split(/\s+/);
  return (words[words.length - 1] ?? '').toUpperCase();
}


async function indicateTyping(row: ChannelDoc, chatRef: string, repos: Repos, messageRef?: string): Promise<void> {
  const adapter = channelAdapter(row.type);
  if (adapter?.indicate === undefined) return;
  try {
    const token = await repos.credentials.resolve(row.tokenCredentialId);
    if (token !== null) await adapter.indicate(token.expose(), chatRef, undefined, messageRef);
  } catch { /* a missing indicator is not a lost message */ }
}

/**
 * A platform's GET probe before it will save the address.
 *
 * Meta sends one with a verify token and expects a challenge echoed back;
 * everything else that probes is content with a 200. The connection's
 * delivery secret is what the verify token is derived from, so a probe
 * for an unknown connection, or with the wrong token, gets nothing.
 */
export async function handleProbe(type: string, channelDocId: string, query: URLSearchParams): Promise<DeliveryOutcome> {
  const adapter = channelAdapter(type);
  if (adapter === undefined) return plain(404, 'unknown channel');
  if (adapter.verify === undefined) return plain(200, 'ok');

  const handle = await db();
  const platform = new PlatformDb(handle.db, 'channel-delivery');
  const row = await platform
    .collection<ChannelDoc>('channels')
    .findOne({ _id: channelDocId, type } as never, { comment: platform.comment });
  if (row === null) return plain(404, 'unknown channel');

  const repos = repositories(handle.db, row.workspaceId);
  const secret = row.secretCredentialId === null || row.secretCredentialId === undefined
    ? undefined
    : await repos.credentials.resolve(row.secretCredentialId);
  const ack = adapter.verify(query, { webhookUrl: webhookUrl(type, channelDocId), webhookSecret: secret?.expose() ?? '' });
  if (ack === undefined) return plain(403, 'forbidden');
  return { status: 200, body: ack.body, contentType: ack.contentType };
}
