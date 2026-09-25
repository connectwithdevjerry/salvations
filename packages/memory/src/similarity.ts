/**
 * Comparing embeddings.
 *
 * The important thing here is the refusal. Embeddings are stored keyed by the
 * model that produced them precisely because vectors from different models are
 * not comparable — the same sentence through two models gives two points in two
 * unrelated spaces, and a cosine between them is a number with no meaning.
 *
 * A length mismatch is the only detectable case, and it is a bug in the caller:
 * something looked up the wrong key. It throws rather than returning zero,
 * because zero would silently rank the entry last and the bug would survive.
 *
 * Two vectors of the SAME length from different models cannot be detected here
 * at all. That is what the model key in storage is for, and why nothing outside
 * the store is ever handed a raw vector to compare.
 */

export class EmbeddingMismatchError extends Error {
  constructor(left: number, right: number) {
    super(
      `Cannot compare a ${left}-dimension embedding with a ${right}-dimension one. `
      + 'They came from different models, and the comparison would be meaningless.',
    );
    this.name = 'EmbeddingMismatchError';
  }
}

/**
 * Cosine similarity, in [-1, 1].
 *
 * Not normalised to [0, 1]: a negative similarity is real information — the
 * texts are opposed rather than merely unrelated — and folding it into the
 * positive range would make "opposite" and "somewhat similar" the same number.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new EmbeddingMismatchError(a.length, b.length);
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  // A zero vector has no direction, so it has no angle to anything. Returning
  // 0 rather than dividing by zero and producing NaN, which would poison every
  // comparison it touched.
  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * A stable key for the model that produced an embedding.
 *
 * Both parts, because model ids collide across vendors far more often than one
 * would like — and a collision here silently compares two unrelated spaces.
 * Non-alphanumerics become underscores because this is used as a document
 * field path, where a dot would nest and a dollar would be rejected.
 */
export function embeddingKey(providerType: string, modelId: string): string {
  return `${providerType}_${modelId}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}
