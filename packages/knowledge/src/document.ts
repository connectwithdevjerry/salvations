/**
 * What a workspace knows.
 *
 * Knowledge is the business context: the documents somebody uploads so that
 * every agent in the workspace can answer from them. It is scoped to the
 * WORKSPACE, not to an agent — it exists before any agent does, and a second
 * agent should not have to be taught what the first one was.
 *
 * A document is stored twice: once as a record of what was uploaded, and once
 * as the chunks retrieval actually reads. The record is what a person sees and
 * deletes; the chunks are what an agent searches. Deleting the record deletes
 * the chunks — there is no such thing as an orphaned chunk that still answers.
 */

export type DocumentStatus =
  /** Chunks are being written. Search skips it until it is ready. */
  | 'ingesting'
  /** Every chunk is stored and searchable. */
  | 'ready'
  /** Ingestion stopped. `error` says why, and the record stays so the person can see it. */
  | 'failed';

export interface KnowledgeDocument {
  readonly id: string;
  readonly title: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** SHA-256 of the extracted text: the same content twice is one document. */
  readonly contentHash: string;
  readonly status: DocumentStatus;
  readonly error: string | undefined;
  readonly chunkCount: number;
  readonly createdAt: Date;
}

export interface KnowledgeChunk {
  readonly id: string;
  readonly documentId: string;
  /** Position within the document, from zero. Reading in order is `index` order. */
  readonly index: number;
  readonly content: string;
}

/**
 * The largest document accepted, in bytes of extracted text.
 *
 * Chosen from the chunk cap rather than the other way round: a megabyte of
 * text is roughly seven hundred chunks, which is the most one search ranks
 * comfortably in-process. Larger is not refused for being big — it is refused
 * because search over it would be silently worse, and "split it" is honest.
 */
export const MAX_DOCUMENT_BYTES = 1_000_000;

/** Longest title stored. Longer ones are trimmed with an ellipsis, not rejected. */
export const MAX_TITLE_LENGTH = 200;

/** A title from a file name: the extension dropped, separators made readable. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_-]+/g, ' ').trim();
  const title = base === '' ? fileName : base;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}
