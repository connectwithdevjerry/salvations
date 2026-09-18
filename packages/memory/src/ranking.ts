/**
 * Choosing which memories to surface.
 *
 * Three signals, because none of them is sufficient alone:
 *
 *  - SIMILARITY finds things that are about the right subject, and is the only
 *    signal that understands paraphrase. It is also absent whenever no
 *    embedding model is configured, which has to degrade rather than break.
 *  - LEXICAL overlap catches the names, ids and jargon an embedding blurs
 *    away — a person asking about "the Henderson account" wants the entry with
 *    that exact word in it, and semantically it is just a proper noun.
 *  - RECENCY breaks ties toward what is currently true. An agent with two
 *    plausible memories should prefer the newer one, because beliefs drift.
 *
 * Importance nudges the total rather than forming a fourth term, so a memory
 * marked important is preferred among comparable candidates but cannot drag an
 * irrelevant entry to the top.
 */

export interface Scored<T> {
  readonly item: T;
  readonly score: number;
  /** Kept for explaining a result, which matters when ranking looks wrong. */
  readonly parts: {
    readonly similarity: number;
    readonly lexical: number;
    readonly recency: number;
  };
}

export interface RankInput {
  readonly content: string;
  readonly importance: number;
  readonly validFrom: Date;
  /** Absent when no embedding model is configured, or for an older entry. */
  readonly similarity?: number;
}

/** How fast a memory's recency advantage decays. */
export const HALF_LIFE_DAYS = 30;

const WEIGHTS = { similarity: 0.6, lexical: 0.3, recency: 0.1 } as const;

/**
 * When nothing has an embedding, similarity carries no information and its
 * weight is redistributed rather than counted as zero. Counting it as zero
 * would compress every score toward the bottom and make the threshold
 * meaningless on a deployment with no embedding model.
 */
const WEIGHTS_WITHOUT_VECTORS = { similarity: 0, lexical: 0.85, recency: 0.15 } as const;

export function rank<T extends RankInput>(
  query: string,
  items: readonly T[],
  now = new Date(),
): readonly Scored<T>[] {
  const terms = tokenise(query);
  const anyVectors = items.some((item) => item.similarity !== undefined);
  const weights = anyVectors ? WEIGHTS : WEIGHTS_WITHOUT_VECTORS;

  return items
    .map((item) => {
      const parts = {
        // Cosine is [-1, 1]; a negative one means actively unrelated, so it is
        // clamped rather than allowed to subtract from the other signals.
        similarity: Math.max(0, item.similarity ?? 0),
        lexical: overlap(terms, tokenise(item.content)),
        recency: decay(item.validFrom, now),
      };

      const base = parts.similarity * weights.similarity
        + parts.lexical * weights.lexical
        + parts.recency * weights.recency;

      // A nudge, not a term: ±20% around the base rather than a share of it,
      // so importance reorders comparable results and cannot promote an
      // irrelevant one.
      const score = base * (0.8 + 0.4 * clamp01(item.importance));

      return { item, score, parts };
    })
    .sort((a, b) => b.score - a.score);
}

/** Exponential decay on a half-life, so age matters most when it is recent. */
export function decay(at: Date, now: Date): number {
  const days = Math.max(0, (now.getTime() - at.getTime()) / 86_400_000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/**
 * Proportion of the query's words present in the content.
 *
 * Over the QUERY's terms rather than Jaccard over both: a long memory that
 * happens to contain every query word is a good match, and Jaccard would
 * penalise it for its length.
 */
export function overlap(queryTerms: readonly string[], contentTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const content = new Set(contentTerms);
  const hits = queryTerms.filter((term) => content.has(term)).length;
  return hits / queryTerms.length;
}

/** Words that appear in almost everything and so distinguish nothing. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'about', 'as', 'by', 'from',
  'that', 'this', 'it', 'i', 'you', 'my', 'your', 'me', 'we', 'do', 'does', 'did',
  'what', 'when', 'where', 'who', 'how', 'why',
]);

export function tokenise(text: string): readonly string[] {
  return text
    .toLowerCase()
    // Apostrophes are kept inside words so "don't" stays one token rather than
    // becoming "don" and a stray "t".
    .split(/[^a-z0-9']+/)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
