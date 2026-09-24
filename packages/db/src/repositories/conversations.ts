/**
 * Conversations and their append-only message log.
 */
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import type { ConversationDoc, MessageDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

export interface AppendMessageInput {
  readonly conversationId: string;
  readonly role: MessageDoc['role'];
  readonly content: unknown[];
  readonly providerArtifacts?: Record<string, unknown>;
  readonly runId?: string;
  readonly tokenEstimate?: number;
  /**
   * Caller-supplied de-duplication key. Present, the message id is derived from
   * it, so a retried submission collides on _id instead of appending a
   * duplicate — idempotency without a transaction.
   */
  readonly clientMessageId?: string;
}

export class ConversationRepository {
  readonly #conversations: ScopedCollection<ConversationDoc>;
  readonly #messages: ScopedCollection<MessageDoc>;

  constructor(db: Db, workspaceId: string) {
    const scoped = new ScopedDb(db, workspaceId);
    this.#conversations = scoped.collection<ConversationDoc>('conversations');
    this.#messages = scoped.collection<MessageDoc>('messages');
  }

  async findById(conversationId: string): Promise<ConversationDoc | null> {
    return this.#conversations.findOne({ _id: conversationId } as never);
  }

  /**
   * Deletes a conversation and every message in it.
   *
   * Runs are left as they are: they are the audit record of what the
   * assistant did and what it cost, which a deleted chat does not undo.
   */
  async remove(conversationId: string): Promise<boolean> {
    await this.#messages.deleteMany({ conversationId } as never);
    const result = await this.#conversations.deleteOne({ _id: conversationId } as never);
    return result.deletedCount === 1;
  }

  /** Empties a conversation but keeps it, with its model and its channel link. */
  async clear(conversationId: string): Promise<number> {
    const result = await this.#messages.deleteMany({ conversationId } as never);
    await this.#conversations.updateOne(
      { _id: conversationId } as never,
      { $set: { lastMessage: null, updatedAt: new Date() } } as never,
    );
    return result.deletedCount;
  }

  async create(input: {
    agentId: string;
    modelBindingId: string;
    title?: string;
    channelId?: string;
    externalRef?: string;
    createdBy?: string;
  }): Promise<ConversationDoc> {
    const now = new Date();
    return this.#conversations.insertOne({
      _id: newId(IdPrefix.conversation),
      agentId: input.agentId,
      modelBindingId: input.modelBindingId,
      channelId: input.channelId ?? null,
      externalRef: input.externalRef ?? null,
      title: input.title ?? null,
      status: 'active',
      messageCount: 0,
      // Seq 0 is never used, so "no messages yet" and "message zero" are
      // distinguishable in a log.
      nextSeq: 1,
      lastMessage: null,
      compaction: null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    } as never);
  }

  /**
   * Reserves the next sequence number.
   *
   * A read-then-write would hand the same number to two concurrent appenders
   * and violate the unique (conversationId, seq) index — one of them losing its
   * message. $inc is atomic, so every caller gets a distinct value.
   *
   * A caller that reserves and then fails leaves a GAP. That is deliberate:
   * gaps are harmless to readers, duplicates are not, and closing the gap would
   * require a transaction on every append.
   */
  async #allocateSeq(conversationId: string): Promise<number> {
    const before = await this.#conversations.findOneAndUpdate(
      { _id: conversationId } as never,
      { $inc: { nextSeq: 1 } } as never,
      { returnDocument: 'before' },
    );
    if (before === null) throw new Error(`Conversation ${conversationId} not found.`);
    return before.nextSeq;
  }

  /** Deterministic id so a retry collides rather than duplicating. */
  #messageId(conversationId: string, clientMessageId: string | undefined): string {
    if (clientMessageId === undefined) return newId(IdPrefix.message);
    const digest = createHash('sha256')
      .update(`${conversationId}|${clientMessageId}`)
      .digest('hex')
      .slice(0, 32);
    return `${IdPrefix.message}_${digest}`;
  }

  async appendMessage(input: AppendMessageInput): Promise<MessageDoc> {
    const seq = await this.#allocateSeq(input.conversationId);
    const now = new Date();

    const doc = await this.#messages.insertOne({
      _id: this.#messageId(input.conversationId, input.clientMessageId),
      conversationId: input.conversationId,
      seq,
      role: input.role,
      content: input.content,
      providerArtifacts: input.providerArtifacts ?? null,
      runId: input.runId ?? null,
      tokenEstimate: input.tokenEstimate ?? null,
      createdAt: now,
      supersededBy: null,
    } as never);

    // Denormalised for list views; a failure here costs a stale preview, never
    // the message itself, so it is not worth a transaction.
    await this.#conversations.updateOne(
      { _id: input.conversationId } as never,
      {
        $inc: { messageCount: 1 },
        $set: {
          updatedAt: now,
          lastMessage: { role: input.role, preview: previewOf(input.content), at: now },
        },
      } as never,
    );

    return doc;
  }

  /** Newest-first window, returned oldest-first for replay into a prompt. */
  async recentMessages(conversationId: string, limit = 50): Promise<MessageDoc[]> {
    const docs = await this.#messages.find(
      { conversationId, supersededBy: null } as never,
      { sort: { seq: -1 }, limit },
    );
    return docs.reverse();
  }

  async messagesSince(conversationId: string, afterSeq: number): Promise<MessageDoc[]> {
    return this.#messages.find(
      { conversationId, seq: { $gt: afterSeq }, supersededBy: null } as never,
      { sort: { seq: 1 } },
    );
  }

  async list(limit = 50): Promise<ConversationDoc[]> {
    return this.#conversations.find(
      { status: 'active' } as never,
      { sort: { updatedAt: -1 }, limit },
    );
  }

  async setModelBinding(conversationId: string, modelBindingId: string): Promise<void> {
    // Switching vendor mid-conversation is a normal operation, not a migration:
    // history is canonical and artifacts are keyed by the model that made them.
    await this.#conversations.updateOne(
      { _id: conversationId } as never,
      { $set: { modelBindingId, updatedAt: new Date() } } as never,
    );
  }

  /**
   * Marks messages as replaced by a summary.
   *
   * Individually, by id, rather than by a sequence range: compaction chooses a
   * boundary that never splits a tool call from its result, so the set is not
   * always a clean prefix and a range would either orphan a pair or keep a
   * message the summary already covers.
   */
  async supersedeMessages(
    conversationId: string,
    messageIds: readonly string[],
    summaryMessageId: string,
  ): Promise<number> {
    if (messageIds.length === 0) return 0;
    const result = await this.#messages.updateMany(
      { conversationId, _id: { $in: [...messageIds] }, supersededBy: null } as never,
      { $set: { supersededBy: summaryMessageId } } as never,
    );
    return result.modifiedCount;
  }

  async recordCompaction(
    conversationId: string,
    upToSeq: number,
    summaryMessageId: string,
  ): Promise<void> {
    await this.#conversations.updateOne(
      { _id: conversationId } as never,
      { $set: { compaction: { upToSeq, summaryMessageId }, updatedAt: new Date() } } as never,
    );
  }
}

function previewOf(content: unknown[]): string {
  for (const block of content) {
    if (
      block !== null && typeof block === 'object' &&
      (block as { type?: string }).type === 'text'
    ) {
      const text = (block as { text?: string }).text ?? '';
      return text.length > 140 ? `${text.slice(0, 140)}…` : text;
    }
  }
  return '';
}
