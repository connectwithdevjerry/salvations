/**
 * Pictures and clips an assistant made.
 *
 * Bytes are capped here, before the driver sees them: a document that would
 * not fit is refused with a sentence rather than a driver error mid-run.
 */
import { Binary, type Db } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import type { MediaDoc } from '../documents';
import { PlatformDb, ScopedDb, type ScopedCollection } from '../scoped';

/** Under MongoDB's 16 MB document limit with room for the rest of the row. */
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

export class MediaTooLargeError extends Error {
  constructor(size: number) {
    super(`That file is ${Math.round(size / 1024 / 1024)} MB; the most that can be kept is ${MAX_MEDIA_BYTES / 1024 / 1024} MB.`);
    this.name = 'MediaTooLargeError';
  }
}

export class MediaRepository {
  readonly #collection: ScopedCollection<MediaDoc>;

  constructor(db: Db, workspaceId: string) {
    this.#collection = new ScopedDb(db, workspaceId).collection<MediaDoc>('media');
  }

  /** A finished picture: stored ready, bytes and all. */
  async createReady(input: {
    kind: MediaDoc['kind']; mimeType: string; prompt: string; bytes: Uint8Array;
    agentId?: string; runId?: string; conversationId?: string;
  }): Promise<MediaDoc> {
    if (input.bytes.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError(input.bytes.byteLength);
    const now = new Date();
    return this.#collection.insertOne({
      _id: newId(IdPrefix.media),
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      conversationId: input.conversationId ?? null,
      kind: input.kind,
      mimeType: input.mimeType,
      status: 'ready',
      prompt: input.prompt,
      bytes: new Binary(input.bytes) as never,
      sizeBytes: input.bytes.byteLength,
      job: null,
      error: null,
      createdAt: now,
      readyAt: now,
    } as never);
  }

  /** A clip the vendor is still rendering. */
  async createRendering(input: {
    mimeType: string; prompt: string; job: { providerType: string; externalId: string };
    agentId?: string; runId?: string; conversationId?: string;
  }): Promise<MediaDoc> {
    return this.#collection.insertOne({
      _id: newId(IdPrefix.media),
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      conversationId: input.conversationId ?? null,
      kind: 'video',
      mimeType: input.mimeType,
      status: 'rendering',
      prompt: input.prompt,
      bytes: null,
      sizeBytes: null,
      job: input.job,
      error: null,
      createdAt: new Date(),
      readyAt: null,
    } as never);
  }

  async markReady(mediaId: string, bytes: Uint8Array): Promise<boolean> {
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError(bytes.byteLength);
    const result = await this.#collection.updateOne(
      { _id: mediaId, status: 'rendering' } as never,
      { $set: { status: 'ready', bytes: new Binary(bytes), sizeBytes: bytes.byteLength, readyAt: new Date() } } as never,
    );
    return result.matchedCount === 1;
  }

  async markFailed(mediaId: string, error: string): Promise<void> {
    await this.#collection.updateOne(
      { _id: mediaId, status: 'rendering' } as never,
      { $set: { status: 'failed', error: error.slice(0, 500) } } as never,
    );
  }

  findById(mediaId: string): Promise<MediaDoc | null> {
    return this.#collection.findOne({ _id: mediaId } as never);
  }

  /** Clips a run started that are not finished: what a finisher has to wait for. */
  renderingForRun(runId: string): Promise<MediaDoc[]> {
    return this.#collection.find({ runId, status: 'rendering' } as never);
  }
}

/**
 * One row by id, whoever holds its link.
 *
 * The link carries a signature over the id, which is what stands in for a
 * session: a chat platform fetching a picture to show it has no account
 * here. Declared as a platform read for that reason, and nothing else is
 * read this way.
 */
export async function findMediaByLink(db: Db, mediaId: string): Promise<MediaDoc | null> {
  const platform = new PlatformDb(db, 'media-serve');
  return platform.collection<MediaDoc>('media').findOne({ _id: mediaId } as never, { comment: platform.comment });
}

/** The bytes as the driver hands them back, whatever BSON wrapped them in. */
export const mediaBytesOf = (doc: MediaDoc): Uint8Array | undefined => {
  const raw = doc.bytes as unknown;
  if (raw === null || raw === undefined) return undefined;
  if (raw instanceof Binary) return new Uint8Array(raw.buffer);
  if (raw instanceof Uint8Array) return raw;
  return undefined;
};
