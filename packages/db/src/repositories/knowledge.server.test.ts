/**
 * Knowledge against a real MongoDB.
 *
 * The claims that need a database: the text index answers a lexical search
 * scoped to the workspace, the same content uploaded twice is one document,
 * a document mid-ingestion does not answer, and deleting a document leaves
 * no chunk behind.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { KnowledgeRepository } from './knowledge';
import { syncIndexes } from '../indexes';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_knowledge`;
const WS = 'wks_knowledge';

let client: MongoClient | undefined;
let db: Db;
let repo: KnowledgeRepository;

const upload = (over: Partial<Parameters<KnowledgeRepository['createDocument']>[0]> = {}) =>
  repo.createDocument({
    title: 'Refund policy', fileName: 'refunds.md', mimeType: 'text/markdown',
    sizeBytes: 120, contentHash: 'hash-refunds', text: 'Full refund within thirty days.', createdBy: 'usr_1', ...over,
  });

describe.skipIf(URI === undefined || URI === '')('knowledge against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
    repo = new KnowledgeRepository(db, WS);
  });

  afterAll(async () => { await client?.close(); });

  beforeEach(async () => {
    await db.collection('knowledgeDocuments').deleteMany({});
    await db.collection('knowledgeChunks').deleteMany({});
  });

  it('finds a passage by its words, scoped to the workspace', async () => {
    const doc = await upload();
    expect(doc).not.toBeNull();
    await repo.appendChunks(doc!._id, [
      { index: 0, content: 'Full refund within thirty days of purchase.', embeddings: undefined },
      { index: 1, content: 'The office closes on public holidays.', embeddings: undefined },
    ]);
    await repo.markReady(doc!._id, { chunkCount: 2, embeddingModelKey: undefined });

    // Another workspace with the same words must not appear.
    const other = new KnowledgeRepository(db, 'wks_other');
    const theirs = await other.createDocument({
      title: 'Theirs', fileName: 't.md', mimeType: 'text/markdown', sizeBytes: 1,
      contentHash: 'hash-theirs', text: 'Full refund always.', createdBy: 'usr_2',
    });
    await other.appendChunks(theirs!._id, [{ index: 0, content: 'Full refund always.', embeddings: undefined }]);
    await other.markReady(theirs!._id, { chunkCount: 1, embeddingModelKey: undefined });

    const found = await repo.lexicalCandidates('refund');
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toContain('thirty days');
    expect(found[0]?.embeddings).toBeUndefined();
  });

  it('treats the same content uploaded twice as one document', async () => {
    const [a, b] = await Promise.all([upload(), upload()]);
    // Exactly one of the two concurrent uploads wins; the index decides.
    expect([a, b].filter((d) => d !== null)).toHaveLength(1);
    expect(await repo.findByHash('hash-refunds')).not.toBeNull();
  });

  it('lets a failed upload be tried again', async () => {
    const first = await upload();
    await repo.markFailed(first!._id, 'network went away');
    expect(await repo.findByHash('hash-refunds')).toBeNull();
    const second = await upload();
    expect(second).not.toBeNull();
    // The failed record is kept, so the person can see why the agent did not
    // know it — but it holds no chunks.
    expect((await repo.list()).map((d) => d.status).sort()).toEqual(['failed', 'ingesting']);
  });

  it('does not answer from a document still being ingested', async () => {
    const doc = await upload();
    await repo.appendChunks(doc!._id, [
      { index: 0, content: 'Full refund within thirty days.', embeddings: undefined },
    ]);
    expect(await repo.lexicalCandidates('refund')).toHaveLength(0);
    await repo.markReady(doc!._id, { chunkCount: 1, embeddingModelKey: undefined });
    expect(await repo.lexicalCandidates('refund')).toHaveLength(1);
  });

  it('deletes chunks with their document', async () => {
    const doc = await upload();
    await repo.appendChunks(doc!._id, [
      { index: 0, content: 'one', embeddings: undefined },
      { index: 1, content: 'two', embeddings: undefined },
    ]);
    await repo.markReady(doc!._id, { chunkCount: 2, embeddingModelKey: undefined });

    expect(await repo.remove(doc!._id)).toBe(true);
    expect(await repo.countChunks()).toBe(0);
    expect(await repo.remove(doc!._id)).toBe(false);
  });

  it('reads a document in order from any part', async () => {
    const doc = await upload();
    await repo.appendChunks(doc!._id, [2, 0, 1].map((index) => ({
      index, content: `part ${index}`, embeddings: undefined,
    })));
    const read = await repo.read(doc!._id, 1, 5);
    expect(read.map((c) => c.content)).toEqual(['part 1', 'part 2']);
  });

  it('scans only chunks embedded under the model asked for', async () => {
    const doc = await upload();
    await repo.appendChunks(doc!._id, [
      { index: 0, content: 'a', embeddings: { model_a: [1, 0] } },
      { index: 1, content: 'b', embeddings: { model_b: [0, 1] } },
      { index: 2, content: 'c', embeddings: undefined },
    ]);
    await repo.markReady(doc!._id, { chunkCount: 3, embeddingModelKey: 'model_a' });
    const found = await repo.vectorCandidates('model_a');
    expect(found).toHaveLength(1);
    expect(found[0]?.embeddings?.['model_a']).toEqual([1, 0]);
    expect(found[0]?.embeddings?.['model_b']).toBeUndefined();
  });
});
