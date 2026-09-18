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
import { transcribeAudio } from './transcribe';
import {
  DEFAULT_BUDGET, asId, type RunId, type UserId, type WorkspaceId,
} from '@salvations/core';
import { db } from './db';
import { repositories } from './container';
import { VercelBackgroundTrigger } from './trigger';
import { env } from './env';
import { agentSnapshotFor } from '@/lib/agent-snapshot';

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
      return await completeHandshake(channels, row, message, repos);
    }

    // The connection is bound to ONE chat. A bot token that has leaked is a bot
    // anybody can message; without this, the leak becomes free use of this
    // workspace's model budget and every credential its agent can reach.
    if (row.verifiedChatRef !== null && row.verifiedChatRef !== message.chatRef) {
      await reply(row, message.chatRef, 'This bot is already connected to another chat.', repos);
      return plain(200, 'ok');
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
    if (heard === undefined) return plain(200, 'ok');

    const runId = await startRun(handle.db, row, heard, repos, channels);
    if (runId !== undefined) await channels.attachRun(row._id, message.messageRef, runId);

    return plain(200, 'ok');
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
): Promise<DeliveryOutcome> {
  const offered = offeredCode(message.text);
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
    : await repos.models.forRole(agent.currentVersion.modelRole);

  if (binding === null) {
    await reply(
      row, message.chatRef,
      'I am connected, but no model is set up for me to think with yet. '
      + 'Add one on the Models page and try again.',
      repos,
    );
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
    await reply(
      row, message.chatRef,
      'I got your voice note, but no model is set up to listen to audio yet. '
      + 'Bind one to the transcription role on the Models page.',
      repos,
    );
    return undefined;
  }

  if (outcome.kind === 'failed') {
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
