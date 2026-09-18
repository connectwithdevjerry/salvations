/**
 * Choosing which chunks answer a question.
 *
 * Two signals rather than memory's three. Recency is meaningless here: a
 * pricing sheet uploaded last year is not less true than a memo uploaded
 * today, and preferring the memo would answer pricing questions from the
 * wrong document.
 *
 *  - SIMILARITY, when an embedding model is bound, finds chunks about the
 *    right subject in different words.
 *  - LEXICAL overlap finds the names, numbers and product codes an embedding
 *    blurs away — and is the whole ranking when no embedding model is bound,
 *    which has to work rather than merely not crash.
 */
import { cosine, overlap, tokenise } from '@salvations/memory';

export interface ChunkCandidate {
  readonly content: string;
  /** Absent when no embedding model is configured, or for a chunk stored before one was. */
  readonly similarity?: number;
}

export interface RankedChunk<T> {
  readonly item: T;
  readonly score: number;
  readonly parts: { readonly similarity: number; readonly lexical: number };
}

const WEIGHTS = { similarity: 0.7, lexical: 0.3 } as const;
const WEIGHTS_WITHOUT_VECTORS = { similarity: 0, lexical: 1 } as const;

/**
 * Below this, a chunk is not about the question.
 *
 * Lexical-only, a single matching word out of five scores 0.2; with vectors,
 * an unrelated chunk sits around 0.1. A weak match is worse than none — it
 * spends the model's context and invites an answer from the wrong document.
 */
export const RELEVANCE_FLOOR = 0.12;

export function rankChunks<T extends ChunkCandidate>(
  query: string,
  items: readonly T[],
): readonly RankedChunk<T>[] {
  const terms = tokenise(query);
  const anyVectors = items.some((item) => item.similarity !== undefined);
  const weights = anyVectors ? WEIGHTS : WEIGHTS_WITHOUT_VECTORS;

  return items
    .map((item) => {
      const parts = {
        similarity: Math.max(0, item.similarity ?? 0),
        lexical: overlap(terms, tokenise(item.content)),
      };
      const score = parts.similarity * weights.similarity + parts.lexical * weights.lexical;
      return { item, score, parts };
    })
    .filter((ranked) => ranked.score >= RELEVANCE_FLOOR)
    .sort((a, b) => b.score - a.score);
}

/** Two vectors from the same model, or nothing. Never a comparison across models. */
export function similarityOf(
  stored: readonly number[] | undefined,
  query: readonly number[] | undefined,
): { similarity?: number } {
  if (stored === undefined || query === undefined || stored.length !== query.length) return {};
  return { similarity: cosine(stored, query) };
}
