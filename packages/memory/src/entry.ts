/**
 * What an agent remembers.
 *
 * Bitemporal: an entry is never updated, only superseded. "Why did the agent
 * believe that in March?" stays answerable, and — more practically — a
 * correction cannot destroy the thing it corrects, so a wrong correction is
 * recoverable.
 *
 * Scoped to an AGENT, not a conversation. Memory that vanished when a thread
 * ended would not be memory; the same agent reached on Telegram and in the web
 * chat is the same agent, and it should know the same things.
 */

/** What kind of thing is being remembered. Affects how long it stays useful. */
export type MemoryKind =
  /** How the person likes things done. Rarely goes stale. */
  | 'preference'
  /** Something that is simply true. Stale only if it changes. */
  | 'fact'
  /** Something in progress. Goes stale fast and should be superseded often. */
  | 'task'
  /** Anything else worth carrying forward. */
  | 'note';

export interface MemoryEntry {
  readonly id: string;
  readonly agentId: string;
  readonly kind: MemoryKind;
  /**
   * A short stable handle, when the memory is an answer to a recurring
   * question — "reporting_format", "timezone". Two entries with the same key
   * are the same belief at two points in time, which is what makes automatic
   * supersession possible.
   */
  readonly key: string | undefined;
  readonly content: string;
  /** 0–1. Nudges ranking; never a gate. */
  readonly importance: number;
  readonly sourceRunId: string | undefined;
  readonly validFrom: Date;
  /** Null while current. Set when superseded or forgotten. */
  readonly validTo: Date | null;
  readonly supersededBy: string | null;
}

/** How important an entry is when nobody said. Middling, deliberately. */
export const DEFAULT_IMPORTANCE = 0.5;

/** Longest a single memory may be. */
export const MAX_CONTENT_LENGTH = 2_000;

/**
 * Whether a new entry replaces an existing one.
 *
 * Only on an explicit key match. Replacing on similar CONTENT was the obvious
 * alternative and is wrong: two memories can be near-identical in wording and
 * mean different things ("prefers tables in reports" / "prefers tables in
 * email"), and silently destroying one because it reads like the other is the
 * kind of loss nobody notices until the agent starts getting things wrong.
 */
export function supersedes(
  incoming: { readonly key: string | undefined },
  existing: { readonly key: string | undefined },
): boolean {
  return incoming.key !== undefined
    && incoming.key !== ''
    && incoming.key === existing.key;
}

export const isCurrent = (entry: Pick<MemoryEntry, 'validTo'>): boolean => entry.validTo === null;
