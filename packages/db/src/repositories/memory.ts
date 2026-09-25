/**
 * An agent's memory.
 *
 * Two things carry the weight.
 *
 * Supersession is a single conditional write. A read-then-write would let two
 * concurrent corrections both see the same current entry, close it twice and
 * leave two rows claiming to be current — after which recall returns a belief
 * and its replacement side by side, and the agent contradicts itself.
 *
 * Nothing here ever updates `content`. A correction is a new row plus a close
 * on the old one, which is what makes the history real rather than decorative.
 */
import type { Db, MongoServerError } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import type { MemoryEntryDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

export interface RememberInput {
  readonly agentId: string;
  readonly kind: string;
  readonly key: string | undefined;
  readonly content: string;
  readonly importance: number;
  readonly sourceRunId: string | undefined;
  readonly createdBy: string | undefined;
  readonly embeddings: Record<string, number[]> | undefined;
}

/** Mongo's code for a unique-index collision. */
const DUPLICATE_KEY = 11000;

const isDuplicate = (caught: unknown): boolean =>
  (caught as MongoServerError | undefined)?.code === DUPLICATE_KEY;

/**
 * How many times to re-run a close-then-insert that lost a race.
 *
 * Each retry means another writer inserted between our close and our insert.
 * Three is far beyond what concurrent corrections to one belief produce; more
 * than that is not contention, it is a loop.
 */
const MAX_SUPERSEDE_ATTEMPTS = 3;

/**
 * How many current entries one recall may consider.
 *
 * Retrieval ranks in this process, so this bounds the work. Generous enough
 * that an agent with a normal amount of memory is ranking all of it, and
 * bounded so one with a pathological amount does not stall a run.
 */
export const RECALL_CANDIDATES = 500;

export class MemoryRepository {
  readonly #entries: ScopedCollection<MemoryEntryDoc>;

  constructor(db: Db, workspaceId: string) {
    this.#entries = new ScopedDb(db, workspaceId).collection<MemoryEntryDoc>('memoryEntries');
  }

  /**
   * Writes a memory, closing whatever it replaces.
   *
   * The close happens FIRST and is conditional on the old row still being
   * current. If it is not, somebody else superseded it a moment ago and this
   * write simply becomes another current entry rather than fighting over it —
   * losing a race here should cost a duplicate, never a lost memory.
   */
  async remember(input: RememberInput): Promise<{
    readonly entry: MemoryEntryDoc;
    /**
     * Whether this write actually closed a previous belief.
     *
     * Reported rather than inferred from "a key was supplied", because the
     * FIRST memory under a key replaces nothing — and an agent telling somebody
     * it has replaced what it previously knew, when it knew nothing, is a small
     * lie that makes the rest of what it says harder to trust.
     */
    readonly superseded: boolean;
  }> {
    const keyed = input.key !== undefined && input.key !== '';
    if (!keyed) {
      return { entry: await this.#insert(input, newId(IdPrefix.memoryEntry), new Date()), superseded: false };
    }

    /*
     * Close, then insert, and retry if somebody got in between.
     *
     * Closing alone cannot hold "one current belief per key": three concurrent
     * corrections all close the SAME row — one succeeds, two match nothing —
     * and then all three insert, leaving three entries each claiming to be
     * true. The unique partial index is what actually enforces it; this loop is
     * how a loser of that race recovers rather than failing the agent's write.
     */
    for (let attempt = 0; attempt < MAX_SUPERSEDE_ATTEMPTS; attempt += 1) {
      const now = new Date();
      const id = newId(IdPrefix.memoryEntry);

      const closed = await this.#entries.updateOne(
        { agentId: input.agentId, key: input.key, validTo: null } as never,
        { $set: { validTo: now, supersededBy: id } } as never,
      );

      try {
        const entry = await this.#insert(input, id, now);
        return { entry, superseded: closed.modifiedCount === 1 };
      } catch (caught) {
        // Somebody inserted a current entry after our close. Go round again:
        // this time we will close theirs.
        if (!isDuplicate(caught)) throw caught;
      }
    }

    throw new Error(
      `Could not store a memory under "${input.key ?? ''}" after `
      + `${MAX_SUPERSEDE_ATTEMPTS} attempts — something is rewriting it continuously.`,
    );
  }

  async #insert(input: RememberInput, id: string, now: Date): Promise<MemoryEntryDoc> {
    return this.#entries.insertOne({
      _id: id,
      agentId: input.agentId,
      kind: input.kind,
      key: input.key ?? null,
      content: input.content,
      importance: input.importance,
      sourceRunId: input.sourceRunId ?? null,
      createdBy: input.createdBy ?? null,
      validFrom: now,
      validTo: null,
      supersededBy: null,
      // `{}` rather than null, so a later `embeddings.<model>` write has
      // something to write INTO. A dotted path cannot traverse null.
      embeddings: input.embeddings ?? {},
    } as never);
  }

  /** Everything this agent currently believes, newest first. */
  async current(agentId: string, limit = RECALL_CANDIDATES): Promise<MemoryEntryDoc[]> {
    return this.#entries.find(
      { agentId, validTo: null } as never,
      { sort: { validFrom: -1 }, limit },
    );
  }

  /**
   * The history of one belief, newest first.
   *
   * Includes closed entries, which is the entire point: this is the answer to
   * "what did it think before, and when did that change?".
   */
  async history(agentId: string, key: string, limit = 20): Promise<MemoryEntryDoc[]> {
    return this.#entries.find(
      { agentId, key } as never,
      { sort: { validFrom: -1 }, limit },
    );
  }

  async findById(entryId: string): Promise<MemoryEntryDoc | null> {
    return this.#entries.findOne({ _id: entryId } as never);
  }

  /**
   * Forgets a memory.
   *
   * Closes it rather than deleting it. Somebody asking an agent to forget
   * something wants it to stop acting on it, and a deletion would also destroy
   * the record that it ever did — which is the thing an audit needs most.
   * Returns false when it was already closed, so a repeat is not reported as
   * success it did not perform.
   */
  async forget(agentId: string, entryId: string): Promise<boolean> {
    const result = await this.#entries.updateOne(
      { _id: entryId, agentId, validTo: null } as never,
      { $set: { validTo: new Date() } } as never,
    );
    return result.modifiedCount === 1;
  }

  /**
   * Adds a vector under its model key, leaving any others untouched.
   *
   * A merge rather than a dotted `$set`. The dotted form cannot traverse a null
   * — and an entry written before embeddings existed has exactly that — so it
   * fails with "cannot create field in element {embeddings: null}" on precisely
   * the rows a re-embedding migration exists to fix.
   */
  async attachEmbedding(
    entryId: string,
    modelKey: string,
    vector: readonly number[],
  ): Promise<void> {
    await this.#entries.updateOne(
      { _id: entryId } as never,
      [
        {
          $set: {
            embeddings: {
              $mergeObjects: [
                { $ifNull: ['$embeddings', {}] },
                { [modelKey]: [...vector] },
              ],
            },
          },
        },
      ] as never,
    );
  }

  async countCurrent(agentId: string): Promise<number> {
    return (await this.#entries.find({ agentId, validTo: null } as never)).length;
  }
}
