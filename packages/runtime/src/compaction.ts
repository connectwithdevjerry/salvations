/**
 * Compaction.
 *
 * A long conversation eventually exceeds the model's input window. The wrong
 * answer is to drop the oldest messages: the model then contradicts things it
 * agreed to twenty turns ago and nobody can see why. The right answer is to
 * SUMMARISE them, record that a summary replaced them, and keep the originals.
 *
 * Two structural rules make this safe:
 *
 * 1. A `tool_use` and its `tool_result` are never separated. Every provider
 *    rejects a history where one appears without the other, so a boundary that
 *    falls between them turns a long conversation into a hard failure.
 *
 * 2. Compaction is never silent. It appends a summary message and marks what it
 *    replaced, so the history shows a compaction happened and an operator can
 *    read what was lost.
 */
import {
  messageText, toolUseBlocks,
  type CanonicalMessage, type ContentBlock, type Message, type MessageId,
  type ModelCapabilities,
} from '@salvations/core';
import { estimateTokens } from './context-assembler';

/** Fraction of the input window at which compaction is triggered. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.7;
/** Fraction of the window the history should occupy afterwards. */
export const DEFAULT_COMPACTION_TARGET = 0.4;
/** Turns always kept verbatim, however long they are. */
export const DEFAULT_KEEP_RECENT = 6;

export interface CompactionPolicy {
  readonly threshold?: number;
  readonly target?: number;
  readonly keepRecent?: number;
}

export interface CompactionPlan {
  readonly needed: boolean;
  /** Messages to be replaced by a summary, oldest first. */
  readonly toSummarise: readonly Message[];
  readonly toKeep: readonly Message[];
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly reason?: string;
}

const tokensOf = (messages: readonly Message[]): number =>
  messages.reduce((sum, m) => sum + (m.tokenEstimate ?? estimateTokens(m.content)), 0);

/**
 * Is this index a legal place to cut?
 *
 * A cut immediately before a message that answers a `tool_use` in the previous
 * one would orphan the call. Providers reject that outright.
 */
function isLegalBoundary(messages: readonly Message[], index: number): boolean {
  if (index <= 0 || index >= messages.length) return true;
  const previous = messages[index - 1] as Message;
  const pendingToolUses = toolUseBlocks(previous.content);
  if (pendingToolUses.length === 0) return true;

  // The previous message asked for tools; the next one must be carrying their
  // results, so the pair belongs on the same side of the cut.
  const next = messages[index] as Message;
  return next.role !== 'tool' &&
    !next.content.some((b) => b.type === 'tool_result');
}

/** Walks backwards to the nearest legal cut, so a pair is never split. */
function legalBoundaryAtOrBefore(messages: readonly Message[], index: number): number {
  for (let i = index; i > 0; i--) {
    if (isLegalBoundary(messages, i)) return i;
  }
  return 0;
}

export function planCompaction(
  messages: readonly Message[],
  capabilities: ModelCapabilities,
  policy: CompactionPolicy = {},
): CompactionPlan {
  const threshold = policy.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const target = policy.target ?? DEFAULT_COMPACTION_TARGET;
  const keepRecent = policy.keepRecent ?? DEFAULT_KEEP_RECENT;

  const live = messages.filter((m) => m.supersededBy === undefined);
  const before = tokensOf(live);
  const limit = capabilities.maxInputTokens * threshold;

  if (before <= limit) {
    return {
      needed: false, toSummarise: [], toKeep: live,
      estimatedTokensBefore: before, estimatedTokensAfter: before,
    };
  }

  // Work backwards from the end, keeping messages until the target is met.
  const targetTokens = capabilities.maxInputTokens * target;
  let kept = 0;
  let cut = live.length;

  for (let i = live.length - 1; i >= 0; i--) {
    const message = live[i] as Message;
    const size = message.tokenEstimate ?? estimateTokens(message.content);
    const recentEnough = live.length - i <= keepRecent;
    if (!recentEnough && kept + size > targetTokens) break;
    kept += size;
    cut = i;
  }

  cut = legalBoundaryAtOrBefore(live, cut);

  if (cut === 0) {
    // Nothing can be summarised without splitting a pair, or the recent window
    // alone already exceeds the target. Compaction cannot help here, and
    // pretending otherwise would loop.
    return {
      needed: false, toSummarise: [], toKeep: live,
      estimatedTokensBefore: before, estimatedTokensAfter: before,
      reason:
        'The recent turns alone exceed the compaction target, so summarising older ones ' +
        'would not bring the conversation under the limit.',
    };
  }

  const toSummarise = live.slice(0, cut);
  const toKeep = live.slice(cut);

  return {
    needed: true,
    toSummarise,
    toKeep,
    estimatedTokensBefore: before,
    estimatedTokensAfter: tokensOf(toKeep),
    reason:
      `The conversation reached ${before} estimated tokens, above the ` +
      `${Math.round(limit)} at which this model is compacted.`,
  };
}

/** Produces the summary text. Injected, because it is a model call. */
export type Summariser = (
  messages: readonly CanonicalMessage[],
  signal: AbortSignal,
) => Promise<string>;

export interface CompactionResult {
  /** Appended to the conversation in place of what it replaced. */
  readonly summary: ContentBlock[];
  readonly supersededIds: readonly MessageId[];
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
}

/**
 * Builds the summary message.
 *
 * The summary is marked as such in its own text. A model reading its own
 * context needs to know that a passage is a compressed account rather than a
 * verbatim exchange, or it will quote it back as if someone said it.
 */
export async function compact(
  plan: CompactionPlan,
  summarise: Summariser,
  signal: AbortSignal,
): Promise<CompactionResult> {
  if (!plan.needed) {
    throw new Error('Nothing to compact. Check `plan.needed` before calling compact().');
  }

  const text = await summarise(
    plan.toSummarise.map((m) => ({ role: m.role, content: m.content })),
    signal,
  );

  return {
    summary: [{
      type: 'text',
      text:
        `[Summary of ${plan.toSummarise.length} earlier messages in this conversation. ` +
        'This is a compressed account, not a verbatim transcript.]\n\n' + text,
    }],
    supersededIds: plan.toSummarise.map((m) => m.id),
    estimatedTokensBefore: plan.estimatedTokensBefore,
    estimatedTokensAfter: plan.estimatedTokensAfter,
  };
}

/** A last-resort summary used when the summarising model itself fails.
 *  Losing detail is bad; losing the run because the summariser was down is worse. */
export function fallbackSummary(messages: readonly Message[]): string {
  const lines = messages.map((m) => {
    const text = messageText(m.content).replace(/\s+/g, ' ').trim();
    return `${m.role}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
  });
  return lines.join('\n');
}
