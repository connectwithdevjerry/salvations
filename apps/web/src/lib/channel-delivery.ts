/**
 * Sending a finished answer back to the chat it came from.
 *
 * Runs on the executor's invocation, right after a run reaches a terminal
 * state, because that is the only moment the system knows an answer is
 * complete. A conversation that did not come from a channel costs one indexed
 * lookup and nothing else.
 *
 * Every failure here is swallowed. The run is finished and its answer is
 * already persisted; turning "Telegram was briefly unreachable" into a failed
 * executor response would make the platform retry a slice that has nothing
 * left to do.
 */
import { ChannelRepository, ConversationRepository, PlatformDb, toMessage } from '@salvations/db';
import type { RunDoc } from '@salvations/db';
import { channelAdapter } from '@salvations/channels';
import { db } from './db';
import { repositories } from './container';

/** How far back to look for the answer. A turn is rarely more than a few. */
const RECENT_MESSAGES = 10;

export async function deliverFinishedRun(runId: string): Promise<'sent' | 'skipped'> {
  try {
    return await deliver(runId);
  } catch {
    return 'skipped';
  }
}

async function deliver(runId: string): Promise<'sent' | 'skipped'> {
  const handle = await db();

  // The run id is all the executor has. Finding its workspace is the same
  // unscoped-by-necessity read the inbound path makes, and for the same reason.
  const platform = new PlatformDb(handle.db, 'channel-delivery');
  const run = await platform.collection<RunDoc>('runs').findOne({ _id: runId } as never);
  if (run === null) return 'skipped';

  const conversations = new ConversationRepository(handle.db, run.workspaceId);
  const conversation = await conversations.findById(run.conversationId);
  // The overwhelmingly common case: a conversation somebody is watching in the
  // browser, which needs no delivery at all.
  if (conversation?.channelId === null || conversation?.channelId === undefined) return 'skipped';

  const channels = new ChannelRepository(handle.db, run.workspaceId);
  const row = await channels.findById(conversation.channelId);
  if (row === null || row.status !== 'connected') return 'skipped';

  const identity = await channels.findIdentityByConversation(conversation._id);
  // `externalRef` is the fallback: an identity row can be removed by a
  // disconnect while a run it started is still in flight.
  const chatRef = identity?.chatRef ?? conversation.externalRef;
  if (chatRef === null || chatRef === undefined) return 'skipped';

  const text = await answerOf(conversations, conversation._id, runId, run.status);
  if (text === undefined) return 'skipped';

  const adapter = channelAdapter(row.type);
  if (adapter === undefined) return 'skipped';

  const repos = repositories(handle.db, run.workspaceId);
  const token = await repos.credentials.resolve(row.tokenCredentialId);
  if (token === null) return 'skipped';

  try {
    await adapter.send(token.expose(), chatRef, text);
    await channels.recordDelivery(row._id);
    return 'sent';
  } catch (caught) {
    // Recorded rather than retried. The person can see on the integrations page
    // that the connection is failing, which is more useful than a silent retry
    // against a bot token that has been revoked.
    await channels.recordFailure(row._id, caught instanceof Error ? caught.message : String(caught));
    return 'skipped';
  }
}

/**
 * What to say.
 *
 * The assistant's text for this run, or — when a run ended without producing
 * any — a plain sentence saying so. Silence is the worst possible answer in a
 * chat window: the person cannot tell it from a message that never arrived.
 */
async function answerOf(
  conversations: ConversationRepository,
  conversationId: string,
  runId: string,
  status: string,
): Promise<string | undefined> {
  const recent = await conversations.recentMessages(conversationId, RECENT_MESSAGES);

  const text = recent
    .map(toMessage)
    .filter((message) => message.runId === runId && message.role === 'assistant')
    .flatMap((message) => message.content)
    .filter((block): block is { type: 'text'; text: string } =>
      (block as { type?: string }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (text !== '') return text;

  if (status === 'succeeded') return undefined;
  if (status === 'cancelled') return 'That was cancelled before it finished.';
  return 'Something went wrong on my end and I could not finish that. Try again?';
}
