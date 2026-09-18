/**
 * Knowledge, assembled.
 *
 * Two jobs. INGEST turns an upload into chunks with vectors and marks the
 * document ready only once every chunk is stored — a document is either
 * wholly searchable or not searchable at all. SEARCH pulls lexical candidates
 * from the database's text index and, when an embedding model is bound,
 * semantic candidates from a bounded vector scan, then ranks the union here.
 *
 * Embeddings are optional throughout, as they are for memory. A workspace
 * with nothing bound to the `embedding` role gets keyword search, which is
 * most of the value, and the Knowledge page says so rather than pretending.
 */
import { createHash } from 'node:crypto';
import { Errors } from '@salvations/core';
import { KnowledgeRepository } from '@salvations/db';
import type { Database, KnowledgeChunkDoc, KnowledgeDocumentDoc } from '@salvations/db';
import {
  MAX_CHUNKS_PER_DOCUMENT, MAX_DOCUMENT_BYTES, SUPPORTED_FORMATS, UnsupportedDocumentError,
  chunkText, extractText, kindOf, rankChunks, similarityOf,
} from '@salvations/knowledge';
import type { KnowledgeSource } from '@salvations/servers';
import { embedderFor, type Embedder } from './memory-service';

/** Chunks embedded per provider call. Well under every vendor's batch limit. */
const EMBED_BATCH = 64;

export interface IngestInput {
  readonly database: Database;
  readonly workspaceId: string;
  readonly title: string;
  readonly fileName: string;
  readonly mimeType: string | undefined;
  readonly bytes: Uint8Array;
  readonly createdBy: string;
}

export type IngestOutcome =
  | { readonly status: 'created'; readonly document: KnowledgeDocumentDoc }
  /** The same content is already live. Its document is returned, not a second one. */
  | { readonly status: 'duplicate'; readonly document: KnowledgeDocumentDoc };

export async function ingestDocument(input: IngestInput): Promise<IngestOutcome> {
  const kind = kindOf(input.fileName, input.mimeType);
  if (kind === undefined) {
    throw Errors.validation(
      `"${input.fileName}" is not a format that can be read. Upload ${SUPPORTED_FORMATS} — `
      + 'a PDF or Word document can be exported as one of those first.',
    );
  }

  let text: string;
  try {
    text = extractText(input.bytes, kind).trim();
  } catch (caught) {
    if (caught instanceof UnsupportedDocumentError) throw Errors.validation(caught.message);
    throw caught;
  }

  if (text === '') throw Errors.validation('That document has no text in it.');
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw Errors.validation(
      `That document is larger than ${Math.round(MAX_DOCUMENT_BYTES / 1_000_000)} MB of text. `
      + 'Split it into parts and upload each.',
    );
  }

  const chunks = chunkText(text);
  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    throw Errors.validation(
      `That document would be ${chunks.length} parts, more than the ${MAX_CHUNKS_PER_DOCUMENT} `
      + 'one document may have. Split it and upload each part.',
    );
  }

  const repo = new KnowledgeRepository(input.database, input.workspaceId);
  const contentHash = createHash('sha256').update(text).digest('hex');

  const document = await repo.createDocument({
    title: input.title,
    fileName: input.fileName,
    mimeType: input.mimeType ?? 'text/plain',
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    contentHash,
    text,
    createdBy: input.createdBy,
  });

  if (document === null) {
    const existing = await repo.findByHash(contentHash);
    if (existing === null) throw Errors.conflict('That document was just uploaded by somebody else.');
    return { status: 'duplicate', document: existing };
  }

  try {
    const embedder = await embedderFor(input.database, input.workspaceId);
    const vectors = embedder === undefined ? [] : await embedAll(embedder, chunks.map((c) => c.content));

    await repo.appendChunks(document._id, chunks.map((chunk, index) => {
      const vector = vectors[index];
      return {
        index: chunk.index,
        content: chunk.content,
        embeddings: embedder !== undefined && vector !== undefined
          ? { [embedder.key]: [...vector] }
          : undefined,
      };
    }));

    await repo.markReady(document._id, {
      chunkCount: chunks.length,
      embeddingModelKey: embedder?.key,
    });
  } catch (caught) {
    // Recorded on the document, and its chunks removed: a half-ingested
    // document answers about its first half as though it were whole.
    await repo.markFailed(document._id, caught instanceof Error ? caught.message : String(caught));
    throw caught;
  }

  const ready = await repo.findById(document._id);
  return { status: 'created', document: ready ?? document };
}

async function embedAll(
  embedder: Embedder,
  texts: readonly string[],
): Promise<(readonly number[] | undefined)[]> {
  const out: (readonly number[] | undefined)[] = [];
  for (let at = 0; at < texts.length; at += EMBED_BATCH) {
    out.push(...await embedder.embedMany(texts.slice(at, at + EMBED_BATCH)));
  }
  return out;
}

/** What the page and the API show for one document. */
export function presentDocument(doc: KnowledgeDocumentDoc) {
  return {
    id: doc._id,
    title: doc.title,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    error: doc.error ?? undefined,
    chunkCount: doc.chunkCount,
    embedded: doc.embeddingModelKey != null,
    createdAt: doc.createdAt.toISOString(),
  };
}

export interface SearchHit {
  readonly chunkId: string;
  readonly documentId: string;
  readonly title: string;
  readonly index: number;
  readonly content: string;
  readonly score: number;
}

/**
 * The search itself, shared by the agent's tool and the page's "try it" box.
 *
 * Both signals fetch their own candidates; a chunk found by both is scored
 * once with both. The union is what keeps a proper noun the embedding blurred
 * away, and a paraphrase the words missed, both findable.
 */
export async function searchKnowledge(
  database: Database,
  workspaceId: string,
  query: string,
  limit: number,
): Promise<readonly SearchHit[]> {
  const repo = new KnowledgeRepository(database, workspaceId);
  const embedder = await embedderFor(database, workspaceId);
  const queryVector = embedder === undefined ? undefined : await embedder.embed(query);

  const lexical = await repo.lexicalCandidates(query);
  const semantic = embedder !== undefined && queryVector !== undefined
    ? await repo.vectorCandidates(embedder.key)
    : [];

  const byId = new Map<string, KnowledgeChunkDoc>();
  for (const chunk of [...lexical, ...semantic]) {
    const known = byId.get(chunk._id);
    // Keep whichever copy carries the vector; the lexical fetch projects it out.
    if (known === undefined || (known.embeddings === undefined && chunk.embeddings !== undefined)) {
      byId.set(chunk._id, chunk);
    }
  }
  if (byId.size === 0) return [];

  const ranked = rankChunks(query, [...byId.values()].map((chunk) => ({
    chunk,
    content: chunk.content,
    ...similarityOf(
      embedder === undefined ? undefined : chunk.embeddings?.[embedder.key],
      queryVector,
    ),
  }))).slice(0, limit);

  const titles = new Map<string, string>();
  for (const documentId of new Set(ranked.map((r) => r.item.chunk.documentId))) {
    const doc = await repo.findById(documentId);
    titles.set(documentId, doc?.title ?? 'Untitled');
  }

  return ranked.map((r) => ({
    chunkId: r.item.chunk._id,
    documentId: r.item.chunk.documentId,
    title: titles.get(r.item.chunk.documentId) ?? 'Untitled',
    index: r.item.chunk.index,
    content: r.item.chunk.content,
    score: r.score,
  }));
}

export function createKnowledgeSource(options: {
  database: Database;
  workspaceId: string;
}): KnowledgeSource {
  const repo = new KnowledgeRepository(options.database, options.workspaceId);

  return {
    async search(query, limit) {
      return searchKnowledge(options.database, options.workspaceId, query, limit);
    },

    async documents() {
      const docs = await repo.list();
      return docs
        .filter((doc) => doc.status === 'ready')
        .map((doc) => ({
          id: doc._id, title: doc.title, chunkCount: doc.chunkCount, createdAt: doc.createdAt,
        }));
    },

    async read(documentId, from, count) {
      const doc = await repo.findById(documentId);
      if (doc === null || doc.status !== 'ready') return undefined;
      const chunks = await repo.read(documentId, from, count);
      return {
        title: doc.title,
        chunkCount: doc.chunkCount,
        chunks: chunks.map((c) => ({ index: c.index, content: c.content })),
      };
    },
  };
}
