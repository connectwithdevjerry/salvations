/**
 * Connected chat platforms.
 *
 * Two things here are load-bearing and worth stating plainly.
 *
 * The first is that a connection is not usable until somebody has proved they
 * control the chat. A bot token alone proves nothing about who pasted it, so
 * `claim` is the only path from `pending_verification` to `connected`, and it
 * consumes the code in the same write that sets the status — a second attempt
 * with the same code finds nothing to claim.
 *
 * The second is that an inbound delivery is recorded BEFORE it is acted on. The
 * unique index on (channelId, externalEventId) turns a redelivery into a
 * duplicate-key error, which is the whole of the idempotency: every one of
 * these platforms retries a slow request, and answering twice is the failure
 * people notice.
 */
import type { Db, MongoServerError } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import type { ChannelDoc, ChannelEventDoc, ChannelIdentityDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

/** Mongo's code for a unique-index collision. */
const DUPLICATE_KEY = 11000;

const isDuplicate = (caught: unknown): boolean =>
  (caught as MongoServerError | undefined)?.code === DUPLICATE_KEY;

export interface CreateChannelInput {
  readonly type: string;
  readonly agentId: string;
  readonly modelBindingId: string;
  readonly tokenCredentialId: string;
  readonly secretCredentialId?: string | undefined;
  readonly identity: ChannelDoc['identity'];
  readonly connectCode: string;
  readonly connectCodeTtlMs: number;
  readonly createdBy: string;
}

export class ChannelRepository {
  readonly #channels: ScopedCollection<ChannelDoc>;
  readonly #identities: ScopedCollection<ChannelIdentityDoc>;
  readonly #events: ScopedCollection<ChannelEventDoc>;

  constructor(db: Db, workspaceId: string) {
    const scoped = new ScopedDb(db, workspaceId);
    this.#channels = scoped.collection<ChannelDoc>('channels');
    this.#identities = scoped.collection<ChannelIdentityDoc>('channelIdentities');
    this.#events = scoped.collection<ChannelEventDoc>('channelEvents');
  }

  async list(): Promise<ChannelDoc[]> {
    return this.#channels.find({});
  }

  async findByType(type: string): Promise<ChannelDoc | null> {
    return this.#channels.findOne({ type } as never);
  }

  async findById(id: string): Promise<ChannelDoc | null> {
    return this.#channels.findOne({ _id: id } as never);
  }

  /**
   * Connects a platform.
   *
   * Replaces any existing connection for the same platform rather than failing
   * on the unique index: reconnecting after a token rotation is the common
   * case, and telling somebody to disconnect first is a step that exists only
   * because the code could not handle it.
   */
  async connect(input: CreateChannelInput): Promise<ChannelDoc> {
    const now = new Date();
    await this.#channels.deleteOne({ type: input.type } as never);

    return this.#channels.insertOne({
      _id: newId(IdPrefix.channel),
      type: input.type,
      agentId: input.agentId,
      modelBindingId: input.modelBindingId,
      tokenCredentialId: input.tokenCredentialId,
      secretCredentialId: input.secretCredentialId ?? null,
      status: 'pending_verification',
      identity: input.identity,
      connect: {
        code: input.connectCode,
        expiresAt: new Date(now.getTime() + input.connectCodeTtlMs),
      },
      verifiedChatRef: null,
      health: { lastOkAt: null, lastDeliveryAt: null, consecutiveFailures: 0, lastError: null },
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    } as never);
  }

  /**
   * Completes the ownership handshake.
   *
   * The code is matched and cleared in one write, and the expiry is part of the
   * filter rather than a check beforehand — a read-then-write would let two
   * simultaneous claims both pass. Returns null when there was nothing to
   * claim, which covers a wrong code, an expired one, and a replay equally.
   */
  async claim(channelId: string, code: string, chatRef: string): Promise<ChannelDoc | null> {
    return this.#channels.findOneAndUpdate(
      {
        _id: channelId,
        'connect.code': code,
        'connect.expiresAt': { $gt: new Date() },
      } as never,
      {
        $set: {
          status: 'connected',
          verifiedChatRef: chatRef,
          connect: null,
          updatedAt: new Date(),
          'health.lastOkAt': new Date(),
        },
      } as never,
      { returnDocument: 'after' },
    );
  }

  async disconnect(channelId: string): Promise<void> {
    await this.#channels.deleteOne({ _id: channelId } as never);
    await this.#identities.deleteMany({ channelId } as never);
  }

  /** Issues a fresh code, for somebody who let the first one expire. */
  async reissueCode(channelId: string, code: string, ttlMs: number): Promise<ChannelDoc | null> {
    return this.#channels.findOneAndUpdate(
      { _id: channelId } as never,
      {
        $set: {
          status: 'pending_verification',
          verifiedChatRef: null,
          connect: { code, expiresAt: new Date(Date.now() + ttlMs) },
          updatedAt: new Date(),
        },
      } as never,
      { returnDocument: 'after' },
    );
  }

  async recordDelivery(channelId: string): Promise<void> {
    await this.#channels.updateOne(
      { _id: channelId } as never,
      {
        $set: { 'health.lastDeliveryAt': new Date(), 'health.consecutiveFailures': 0, 'health.lastError': null },
      } as never,
    );
  }

  async recordFailure(channelId: string, message: string): Promise<void> {
    await this.#channels.updateOne(
      { _id: channelId } as never,
      {
        $inc: { 'health.consecutiveFailures': 1 },
        $set: { 'health.lastError': message.slice(0, 500), status: 'error', updatedAt: new Date() },
      } as never,
    );
  }

  /**
   * Claims an inbound delivery, once.
   *
   * True means this caller owns it and should act. False means it is a
   * redelivery somebody else already has — not an error, and not something to
   * retry.
   */
  async claimDelivery(channelId: string, externalEventId: string): Promise<boolean> {
    try {
      await this.#events.insertOne({
        _id: newId(IdPrefix.channelEvent),
        channelId,
        externalEventId,
        outcome: 'accepted',
        runId: null,
        receivedAt: new Date(),
      } as never);
      return true;
    } catch (caught) {
      if (isDuplicate(caught)) return false;
      throw caught;
    }
  }

  async attachRun(channelId: string, externalEventId: string, runId: string): Promise<void> {
    await this.#events.updateOne(
      { channelId, externalEventId } as never,
      { $set: { runId } } as never,
    );
  }

  /** The conversation a person's messages belong to, if they have written before. */
  async findIdentity(channelId: string, externalUserId: string): Promise<ChannelIdentityDoc | null> {
    return this.#identities.findOne({ channelId, externalUserId } as never);
  }

  async findIdentityByConversation(conversationId: string): Promise<ChannelIdentityDoc | null> {
    return this.#identities.findOne({ conversationId } as never);
  }

  /**
   * Remembers where a conversation came from.
   *
   * Upserted on the unique routing key so two messages arriving together cannot
   * create two threads for one person — the loser of the race reads back the
   * winner's row rather than failing.
   */
  async linkIdentity(input: {
    channelId: string;
    externalUserId: string;
    chatRef: string;
    conversationId: string;
    label: string;
  }): Promise<ChannelIdentityDoc> {
    const now = new Date();
    await this.#identities.updateOne(
      { channelId: input.channelId, externalUserId: input.externalUserId } as never,
      {
        $set: { chatRef: input.chatRef, label: input.label, lastSeenAt: now },
        $setOnInsert: {
          _id: newId(IdPrefix.channelIdentity),
          conversationId: input.conversationId,
          userId: null,
          createdAt: now,
        },
      } as never,
      { upsert: true },
    );

    const stored = await this.findIdentity(input.channelId, input.externalUserId);
    if (stored === null) {
      throw new Error('The channel identity vanished immediately after being written.');
    }
    return stored;
  }
}
