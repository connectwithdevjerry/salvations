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
import type { ChannelDoc } from '@salvations/db';
import { channelAdapter, type InboundMessage, type VerifyContext } from '@salvations/channels';
import {
  DEFAULT_BUDGET, asId, type RunId, type UserId, type WorkspaceId,
} from '@salvations/core';
import { db } from './db';
import { repositories } from './container';
import { VercelBackgroundTrigger } from './trigger';
import { env } from './env';

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
export const webhookUrl = (type: string, channelDocId: string): string =>
  `${env().PUBLIC_BASE_URL.replace(/\/$/, '')}/api/channels/${type}/${channelDocId}`;

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
  const row = await new PlatformDb(handle.db, 'channel-delivery')
    .collection<ChannelDoc>('channels')
    .findOne({ _id: channelDocId, type } as never);

  // The same answer for "no such connection" and "wrong platform": a webhook
  // URL is a public string, and confirming which ids exist helps only someone
  // enumerating them.
  if (row === null) return plain(404, 'unknown channel');

  const repos = repositories(handle.db, row.workspaceId);
  const channels = new ChannelRepository(handle.db, row.workspaceId);

  const secret = row.secretCredentialId === null || row.secretCredentialId === undefined
    ? undefined
    : await repos.credentials.resolve(row.secretCredentialId);

  const context: VerifyContext = {
    webhookUrl: webhookUrl(type, channelDocId),
    webhookSecret: secret?.expose() ?? '',
  };

  const judged = adapter.receive(raw, headers, context);

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

    case 'message':
      break;
  }

  const message = judged.message;

  // A redelivery. Acknowledged so the platform stops retrying, and not acted
  // on, because somebody already did.
  if (!await channels.claimDelivery(row._id, message.messageRef)) {
    return plain(200, 'ok');
  }

  await channels.recordDelivery(row._id);

  if (row.status !== 'connected') {
    return await completeHandshake(channels, adapter.channelId, row, message, repos);
  }

  // The connection is bound to ONE chat. A bot token that has leaked is a bot
  // anybody can message; without this, the leak becomes free use of this
  // workspace's model budget and every credential its agent can reach.
  if (row.verifiedChatRef !== null && row.verifiedChatRef !== message.chatRef) {
    await reply(row, message.chatRef, 'This bot is already connected to another chat.', repos);
    return plain(200, 'ok');
  }

  const runId = await startRun(handle.db, row, message, repos, channels);
  if (runId !== undefined) await channels.attachRun(row._id, message.messageRef, runId);

  return plain(200, 'ok');
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
  type: string,
  row: ChannelDoc,
  message: InboundMessage,
  repos: Repos,
): Promise<DeliveryOutcome> {
  const offered = message.text.trim().toUpperCase();
  const claimed = await channels.claim(row._id, offered, message.chatRef);

  if (claimed === null) {
    await reply(
      row, message.chatRef,
      'That code is not right, or it has expired. Open the integrations page for a new one.',
      repos,
    );
    return plain(200, 'ok');
  }

  await reply(
    row, message.chatRef,
    'Connected. This chat is yours now — say anything and your agent will answer.',
    repos,
  );
  void type;
  return plain(200, 'ok');
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

  const conversations = new ConversationRepository(database, row.workspaceId);
  const existing = await channels.findIdentity(row._id, message.senderRef);

  let conversationId = existing?.conversationId;
  if (conversationId === undefined) {
    const created = await conversations.create({
      agentId: row.agentId,
      modelBindingId: row.modelBindingId,
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
    agentSnapshot: agent.currentVersion,
    modelBindingId: row.modelBindingId,
    trigger: { type: 'channel', ref: `${row.type}:${message.senderRef}` },
    /*
     * A platform id identifies somebody; it does not entitle them to anything.
     * `trust: 'unlinked'` says exactly that — this is a Telegram account that
     * has proved it can reach the bot and nothing more. It becomes 'linked'
     * only when the platform account is tied to a HIVE account, and until then
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
