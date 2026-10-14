/**
 * Deciding an approval from the chat it came from.
 *
 * A run that stops to ask used to go quiet on Telegram: the question sat on
 * the Approvals page and the chat showed nothing. Now the question is put in
 * the chat with two buttons, and a press decides it the same way the page
 * does, by the same person who asked. On a platform without buttons the
 * question is still said, with the page named as where to answer.
 *
 * Who may press: the identity the conversation belongs to. The chat that
 * asked is the chat that answers, and a bot token that leaked still cannot
 * approve anything, because a stranger's press carries a stranger's id.
 */
import { asId, type RunId } from '@salvations/core';
import { AuditRepository, MongoRunQueue, type ApprovalDoc, type Database } from '@salvations/db';
import type { InboundChoice } from '@salvations/channels';
import { channelTargetOf, isTarget, type Delivery } from './channel-delivery';
import { WEBHOOK_SPEC, registerWebhook } from './channel-webhook';
import { db } from './db';
import { VercelBackgroundTrigger } from './trigger';
import { repositories, type Repos } from './repositories';

const PREFIX = 'a';

/** The button data: short, because Telegram allows 64 bytes. */
export const encodeDecision = (approvalId: string, decision: 'approve' | 'deny'): string =>
  `${PREFIX}:${approvalId}:${decision === 'approve' ? 'y' : 'n'}`;

export function decodeDecision(data: string): { approvalId: string; decision: 'approve' | 'deny' } | undefined {
  const match = /^a:([A-Za-z0-9_-]{3,80}):([yn])$/.exec(data);
  if (match === null) return undefined;
  return { approvalId: match[1] as string, decision: match[2] === 'y' ? 'approve' : 'deny' };
}

/** What the question says, from what the approval carries. */
export function questionOf(approval: Pick<ApprovalDoc, 'kind' | 'payload'>, canPress: boolean): string {
  const payload = (approval.payload ?? {}) as { capabilityName?: string; canonicalName?: string; reason?: string; question?: string };
  if (approval.kind === 'tool_call') {
    const tool = payload.capabilityName ?? payload.canonicalName ?? 'a tool that changes something';
    const why = isForPeople(payload.reason) ? ` ${sentence(payload.reason as string)}` : '';
    return canPress
      ? `Before I go on, I need your go-ahead to use ${tool}.${why}`
      : `Before I go on, I need your go-ahead to use ${tool}.${why} Approve it on the Approvals page.`;
  }
  const asked = payload.question !== undefined && payload.question !== '' ? ` ${sentence(payload.question)}` : '';
  return `I need something from you before I can go on.${asked} Answer on the Approvals page.`;
}

/** A policy's own name for its decision ("policy:default") is not a reason a person can read. */
export const isForPeople = (reason: string | undefined): boolean =>
  reason !== undefined && reason.trim() !== '' && !/^policy\b/i.test(reason.trim());

const sentence = (text: string): string => {
  const trimmed = text.trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

/**
 * Puts a waiting run's question in its chat, once.
 *
 * Called beside the executor when a slice ends suspended. Finding nothing
 * to ask, or a conversation that did not come from a chat, is the common
 * case and costs one read.
 */
export async function announcePendingApproval(runId: string): Promise<Delivery> {
  try {
    const target = await channelTargetOf(runId);
    if (!isTarget(target)) return { result: 'skipped', reason: target.reason };
    const handle = await db();
    const runs = repositories(handle.db, target.run.workspaceId).runs;
    const approval = await runs.pendingApprovalForRun(runId);
    if (approval === null) return { result: 'skipped', reason: 'nothing pending' };
    if (approval.announced !== null && approval.announced !== undefined) return { result: 'skipped', reason: 'already asked' };

    const { adapter, token, chatRef, row } = target;
    const canPress = approval.kind === 'tool_call' && adapter.sendChoices !== undefined;
    // Buttons are only worth sending if a press can reach us. A bot registered
    // before presses were asked for is re-pointed first; the daily sweep
    // would get there too, but not before this question.
    if (canPress && (row.webhookSpec ?? 1) !== WEBHOOK_SPEC) {
      await registerWebhook(handle.db, row).catch(() => undefined);
    }
    const text = questionOf(approval, canPress);
    const messageRef = canPress && adapter.sendChoices !== undefined
      ? await adapter.sendChoices(token, chatRef, text, [
        { label: 'Approve', data: encodeDecision(approval._id, 'approve') },
        { label: 'Not now', data: encodeDecision(approval._id, 'deny') },
      ])
      : (await adapter.send(token, chatRef, text), '');
    await runs.markAnnounced(approval._id, row._id, messageRef);
    await target.channels.recordDelivery(row._id);
    return { result: 'sent' };
  } catch (caught) {
    return { result: 'skipped', reason: `threw: ${caught instanceof Error ? caught.message : String(caught)}` };
  }
}

export interface ChatDecision {
  /** What the chat is told, in place of the question. */
  readonly text: string;
  readonly decided: boolean;
}

/**
 * Acts on a press.
 *
 * The approval must belong to a run in a conversation on this very
 * connection, and the press must come from the identity that owns that
 * conversation. Anything else is answered politely and changes nothing.
 */
export async function decideFromChat(input: {
  readonly database: Database;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly choice: InboundChoice;
  readonly repos: Repos;
}): Promise<ChatDecision> {
  const { database, workspaceId, channelId, choice, repos } = input;
  const parsed = decodeDecision(choice.data);
  if (parsed === undefined) return { text: 'That button is from something I no longer have.', decided: false };

  const approval = await repos.runs.findApproval(parsed.approvalId);
  if (approval === null) return { text: 'That question is gone.', decided: false };

  const run = await repos.runs.findById(approval.runId);
  if (run === null) return { text: 'That run is gone.', decided: false };
  if (!run.status.startsWith('waiting_')) {
    return { text: 'That moment has passed; I moved on with what you said next. Ask me again if you still want it.', decided: false };
  }
  const identity = await repos.channels.findIdentityByConversation(run.conversationId);
  if (identity === null || identity.channelId !== channelId || identity.externalUserId !== choice.senderRef) {
    return { text: 'Only the person who asked can decide this.', decided: false };
  }

  if (approval.decision !== null && approval.decision !== undefined) {
    return { text: approval.decision === 'approve' ? 'Already approved.' : 'Already declined.', decided: false };
  }
  if (approval.expiresAt.getTime() < Date.now()) {
    return { text: 'That question expired. Ask me again and I will start over.', decided: false };
  }

  const recorded = await repos.runs.decideApproval(approval._id, parsed.decision, `channel:${channelId}:${choice.senderRef}`);
  if (!recorded) return { text: 'Someone answered that a moment ago.', decided: false };

  await new AuditRepository(database, workspaceId).write({
    actor: { type: 'channel', id: `${channelId}:${choice.senderRef}` },
    action: parsed.decision === 'approve' ? 'approval.approved' : 'approval.denied',
    subject: { type: 'approval', id: approval._id },
    metadata: { runId: approval.runId, via: 'chat' },
  });

  // Back to queued, then a wake-up, in that order: a push that arrived first
  // would find a run still marked as waiting and do nothing.
  await new MongoRunQueue(database).enqueue(approval.runId);
  await new VercelBackgroundTrigger().trigger(asId<RunId>(approval.runId));

  return {
    text: parsed.decision === 'approve' ? 'Approved. Carrying on.' : 'Understood. I will not do that.',
    decided: true,
  };
}
