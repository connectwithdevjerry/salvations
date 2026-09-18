/**
 * What the workspace knows, stored.
 *
 * Two collections with one owner. A document row is what a person sees and
 * deletes; chunk rows are what search reads. Every write to chunks goes
 * through here with the document it belongs to, and deleting a document
 * deletes its chunks first — there is no path that leaves a chunk answering
 * for a document that no longer exists.
 *
 * Candidate selection is split by signal. Lexical candidates come from the
 * database's own text index, which scales with the collection rather than
 * with this process; semantic candidates are a bounded scan of stored vectors,
 * because a self-hosted MongoDB has no `$vectorSearch`. The ranking that
 * combines them lives in packages/knowledge and runs here, in-process.
 */
import type { Db, MongoServerError } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import type { KnowledgeChunkDoc, KnowledgeDocumentDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

export interface CreateDocumentInput {
  readonly title: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly contentHash: string;
  readonly createdBy: string;
}

export interface ChunkInput {
  readonly index: number;
  readonly content: string;
  readonly embeddings: Record<string, number[]> | undefined;
}

/** Mongo's code for a unique-index collision. */
const DUPLICATE_KEY = 11000;

export const isDuplicateKey = (caught: unknown): boolean =>
  (caught as MongoServerError | undefined)?.code === DUPLICATE_KEY;

/** Chunks written per insert. Vectors make chunks heavy; batches keep one write sane. */
const INSERT_BATCH = 100;

/** Most lexical candidates one search reads from the text index. */
export const LEXICAL_CANDIDATES = 100;

/**
 * Most chunks scanned for vector similarity in one search.
 *
 * At 1,536 dimensions this is roughly twenty megabytes of numbers per search,
 * which is the ceiling for doing it in-process. Beyond it, the lexical
 * candidates alone answer — degraded, and honestly so, rather than a search
 * that stalls the run.
 */
export const VECTOR_CANDIDATES = 1_500;

export class KnowledgeRepository {
  readonly #documents: ScopedCollection<KnowledgeDocumentDoc>;
  readonly #chunks: ScopedCollection<KnowledgeChunkDoc>;

  constructor(db: Db, workspaceId: string) {
    const scoped = new ScopedDb(db, workspaceId);
    this.#documents = scoped.collection<KnowledgeDocumentDoc>('knowledgeDocuments');
    this.#chunks = scoped.collection<KnowledgeChunkDoc>('knowledgeChunks');
  }

  /**
   * Records an upload before its chunks exist.
   *
   * Returns null when the same content is already live: the unique partial
   * index decides, not a read-then-write, so two identical uploads arriving
   * together produce one document rather than two answering in stereo.
   */
  async createDocument(input: CreateDocumentInput): Promise<KnowledgeDocumentDoc | null> {
    const now = new Date();
    try {
      return await this.#documents.insertOne({
        _id: newId(IdPrefix.knowledgeDocument),
        title: input.title,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        contentHash: input.contentHash,
        status: 'ingesting',
        error: null,
        chunkCount: 0,
        embeddingModelKey: null,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      } as never);
    } catch (caught) {
      if (isDuplicateKey(caught)) return null;
      throw caught;
    }
  }

  async findByHash(contentHash: string): Promise<KnowledgeDocumentDoc | null> {
    return this.#documents.findOne(
      { contentHash, status: { $in: ['ingesting', 'ready'] } } as never,
    );
  }

  async appendChunks(documentId: string, chunks: readonly ChunkInput[]): Promise<number> {
    let written = 0;
    for (let at = 0; at < chunks.length; at += INSERT_BATCH) {
      const batch = chunks.slice(at, at + INSERT_BATCH).map((chunk) => ({
        _id: newId(IdPrefix.knowledgeChunk),
        documentId,
        index: chunk.index,
        content: chunk.content,
        // `{}` rather than null, so a later per-model write has something to
        // write into. A dotted path cannot traverse null.
        embeddings: chunk.embeddings ?? {},
        createdAt: new Date(),
      }));
      const inserted = await this.#chunks.insertMany(batch as never);
      written += inserted.length;
    }
    return written;
  }

  async markReady(
    documentId: string,
    outcome: { chunkCount: number; embeddingModelKey: string | undefined },
  ): Promise<void> {
    await this.#documents.updateOne(
      { _id: documentId } as never,
      {
        $set: {
          status: 'ready',
          chunkCount: outcome.chunkCount,
          embeddingModelKey: outcome.embeddingModelKey ?? null,
          error: null,
          updatedAt: new Date(),
        },
      } as never,
    );
  }

  /**
   * Records why ingestion stopped, and removes whatever chunks it had written.
   *
   * A failed document keeps its row so the person can see what went wrong and
   * why the agent does not know it. It keeps no chunks: a half-ingested
   * document answers questions about its first half as though it were whole.
   */
  async markFailed(documentId: string, error: string): Promise<void> {
    await this.#chunks.deleteMany({ documentId } as never);
    await this.#documents.updateOne(
      { _id: documentId } as never,
      { $set: { status: 'failed', error: error.slice(0, 500), chunkCount: 0, updatedAt: new Date() } } as never,
    );
  }

  /** Every document, newest first. */
  async list(): Promise<KnowledgeDocumentDoc[]> {
    return this.#documents.find({} as never, { sort: { createdAt: -1 } });
  }

  async findById(documentId: string): Promise<KnowledgeDocumentDoc | null> {
    return this.#documents.findOne({ _id: documentId } as never);
  }

  /** Chunks first, then the record. Returns false when there was nothing to delete. */
  async remove(documentId: string): Promise<boolean> {
    await this.#chunks.deleteMany({ documentId } as never);
    const result = await this.#documents.deleteOne({ _id: documentId } as never);
    return result.deletedCount === 1;
  }

  /** A run of a document's chunks in reading order. */
  async read(documentId: string, from: number, count: number): Promise<KnowledgeChunkDoc[]> {
    return this.#chunks.find(
      { documentId, index: { $gte: from } } as never,
      { sort: { index: 1 }, limit: count, projection: { embeddings: 0 } },
    );
  }

  /**
   * Chunks the text index thinks match, best first.
   *
   * Only from documents that are ready: a document mid-ingestion would answer
   * with whichever chunks happened to land first.
   */
  async lexicalCandidates(query: string, limit = LEXICAL_CANDIDATES): Promise<KnowledgeChunkDoc[]> {
    const ready = await this.#readyDocumentIds();
    if (ready.length === 0) return [];
    return this.#chunks.find(
      { $text: { $search: query }, documentId: { $in: ready } } as never,
      {
        sort: { score: { $meta: 'textScore' } } as never,
        limit,
        projection: { embeddings: 0 },
      },
    );
  }

  /**
   * A bounded scan of chunks carrying a vector under one model.
   *
   * Projects only that model's vector, so a workspace re-embedded under a
   * second model does not double the bytes every search moves.
   */
  async vectorCandidates(modelKey: string, limit = VECTOR_CANDIDATES): Promise<KnowledgeChunkDoc[]> {
    const ready = await this.#readyDocumentIds();
    if (ready.length === 0) return [];
    return this.#chunks.find(
      { documentId: { $in: ready }, [`embeddings.${modelKey}`]: { $exists: true } } as never,
      { limit, projection: { content: 1, documentId: 1, index: 1, [`embeddings.${modelKey}`]: 1 } },
    );
  }

  async countChunks(): Promise<number> {
    return this.#chunks.countDocuments({} as never);
  }

  async #readyDocumentIds(): Promise<string[]> {
    const docs = await this.#documents.find({ status: 'ready' } as never, { projection: { _id: 1 } });
    return docs.map((doc) => doc._id);
  }
}
