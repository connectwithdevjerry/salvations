import { describe, expect, it } from 'vitest';
import { cosine, embeddingKey, EmbeddingMismatchError } from './similarity';
import { supersedes, isCurrent, DEFAULT_IMPORTANCE } from './entry';
import { rank, decay, overlap, tokenise, HALF_LIFE_DAYS } from './ranking';

describe('comparing embeddings', () => {
  it('is 1 for a vector against itself', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('keeps a negative similarity negative', () => {
    // Opposed is real information. Folding it into [0,1] would make "opposite"
    // and "somewhat similar" the same number.
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('refuses vectors of different lengths rather than returning zero', () => {
    /*
     * A length mismatch means the caller looked up the wrong model key, and
     * the comparison is meaningless. Returning 0 would rank the entry last and
     * the bug would survive indefinitely.
     */
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(EmbeddingMismatchError);
  });

  it('returns 0 for a zero vector rather than NaN', () => {
    // Dividing by a zero norm gives NaN, which poisons every comparison it
    // touches and sorts unpredictably.
    expect(cosine([0, 0], [1, 2])).toBe(0);
    expect(Number.isNaN(cosine([0, 0], [1, 2]))).toBe(false);
  });

  it('keys an embedding by vendor AND model', () => {
    // Model ids collide across vendors, and a collision silently compares two
    // unrelated vector spaces.
    expect(embeddingKey('openai', 'text-embedding-3-large'))
      .toBe('openai_text_embedding_3_large');
    expect(embeddingKey('openai', 'embed-v1')).not.toBe(embeddingKey('google', 'embed-v1'));
  });

  it('produces a key usable as a document field path', () => {
    // A dot would nest the field and a dollar would be rejected outright.
    const key = embeddingKey('some.vendor', 'model$v1.5');
    expect(key).not.toMatch(/[.$]/);
  });
});

describe('superseding', () => {
  it('replaces an entry with the same key', () => {
    expect(supersedes({ key: 'timezone' }, { key: 'timezone' })).toBe(true);
  });

  it('does not replace an entry with a different key', () => {
    expect(supersedes({ key: 'timezone' }, { key: 'reporting_format' })).toBe(false);
  });

  it('never replaces anything when the incoming entry has no key', () => {
    /*
     * The alternative — superseding on similar content — silently destroys
     * memories that read alike but mean different things ("prefers tables in
     * reports" vs "prefers tables in email"). Nobody notices until the agent
     * starts getting things wrong.
     */
    expect(supersedes({ key: undefined }, { key: undefined })).toBe(false);
    expect(supersedes({ key: '' }, { key: '' })).toBe(false);
  });

  it('treats an entry with no validTo as current', () => {
    expect(isCurrent({ validTo: null })).toBe(true);
    expect(isCurrent({ validTo: new Date() })).toBe(false);
  });
});

describe('tokenising', () => {
  it('drops words that distinguish nothing', () => {
    expect(tokenise('what is the reporting format')).toEqual(['reporting', 'format']);
  });

  it('keeps an apostrophe inside a word', () => {
    // Splitting on it would turn "don't" into "don" and a stray "t".
    expect(tokenise("don't ship on fridays")).toContain("don't");
  });

  it('drops single characters', () => {
    expect(tokenise('a b cd')).toEqual(['cd']);
  });
});

describe('lexical overlap', () => {
  it('measures against the query, not both sides', () => {
    /*
     * A long memory containing every query word is a good match. Jaccard over
     * the union would penalise it for its length, which is backwards.
     */
    const query = tokenise('henderson account');
    const long = tokenise('the henderson account was renewed in March after a long negotiation');
    expect(overlap(query, long)).toBe(1);
  });

  it('is 0 when nothing matches', () => {
    expect(overlap(tokenise('kangaroo'), tokenise('reporting format'))).toBe(0);
  });

  it('is 0 for an empty query rather than dividing by zero', () => {
    expect(overlap([], tokenise('anything'))).toBe(0);
  });
});

describe('recency decay', () => {
  const now = new Date('2026-06-01T00:00:00Z');

  it('is 1 for something remembered just now', () => {
    expect(decay(now, now)).toBeCloseTo(1);
  });

  it('is a half at one half-life', () => {
    const then = new Date(now.getTime() - HALF_LIFE_DAYS * 86_400_000);
    expect(decay(then, now)).toBeCloseTo(0.5);
  });

  it('never goes negative for a future date', () => {
    // Clock skew between a webhook and this process is normal, and a negative
    // age would produce a decay above 1 and outrank everything.
    const future = new Date(now.getTime() + 86_400_000);
    expect(decay(future, now)).toBeLessThanOrEqual(1);
  });
});

describe('ranking', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const entry = (over: Partial<Parameters<typeof rank>[1][number]> = {}) => ({
    content: 'prefers tables over prose',
    importance: DEFAULT_IMPORTANCE,
    validFrom: now,
    ...over,
  });

  it('puts an exact lexical match above an unrelated entry', () => {
    const ranked = rank('reporting format', [
      entry({ content: 'likes cats' }),
      entry({ content: 'reporting format should be a table' }),
    ], now);

    expect(ranked[0]?.item.content).toContain('reporting format');
  });

  it('prefers the newer of two equally relevant memories', () => {
    // Beliefs drift. Two plausible memories should resolve toward the current
    // one rather than arbitrarily.
    const old = entry({ validFrom: new Date(now.getTime() - 200 * 86_400_000) });
    const recent = entry();
    const ranked = rank('tables prose', [old, recent], now);

    expect(ranked[0]?.item).toBe(recent);
  });

  it('uses similarity when embeddings are present', () => {
    const ranked = rank('how should I format the report', [
      entry({ content: 'completely unrelated words here', similarity: 0.95 }),
      entry({ content: 'also unrelated words entirely', similarity: 0.1 }),
    ], now);

    // Neither matches lexically, so similarity is the only thing separating
    // them — which is the case embeddings exist for.
    expect(ranked[0]?.parts.similarity).toBeCloseTo(0.95);
  });

  it('clamps a negative similarity rather than letting it subtract', () => {
    const ranked = rank('anything', [entry({ similarity: -0.8 })], now);
    expect(ranked[0]?.parts.similarity).toBe(0);
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(0);
  });

  it('still separates results when nothing has an embedding', () => {
    /*
     * A deployment with no embedding model configured must still rank. If the
     * similarity weight were simply counted as zero, every score would be
     * compressed toward the bottom and a threshold would become meaningless.
     */
    const ranked = rank('reporting format', [
      entry({ content: 'likes cats' }),
      entry({ content: 'the reporting format is a table' }),
    ], now);

    expect(ranked[0]?.score).toBeGreaterThan(0.3);
    expect(ranked[0]?.score).toBeGreaterThan((ranked[1]?.score ?? 0) * 2);
  });

  it('lets importance reorder comparable results', () => {
    const plain = entry({ content: 'the reporting format is a table', importance: 0.1 });
    const important = entry({ content: 'the reporting format is a table', importance: 1 });
    const ranked = rank('reporting format', [plain, important], now);

    expect(ranked[0]?.item).toBe(important);
  });

  it('does not let importance promote an irrelevant memory', () => {
    // A nudge, not a term. Otherwise "important" becomes a way to poison recall
    // with something that has nothing to do with the question.
    const irrelevant = entry({ content: 'likes cats', importance: 1 });
    const relevant = entry({ content: 'the reporting format is a table', importance: 0 });
    const ranked = rank('reporting format', [irrelevant, relevant], now);

    expect(ranked[0]?.item).toBe(relevant);
  });

  it('returns results in descending score order', () => {
    const ranked = rank('reporting format', [
      entry({ content: 'likes cats' }),
      entry({ content: 'the reporting format is a table' }),
      entry({ content: 'format' }),
    ], now);

    const scores = ranked.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
