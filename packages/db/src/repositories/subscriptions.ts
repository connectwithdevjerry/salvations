/**
 * Subscriptions.
 *
 * A cache of the processor's record, never the source of truth. Every write
 * here comes from something the processor said — a webhook, or a re-read after
 * one was missed — which is why there is no method that invents a status.
 */
import type { Db } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import type { SubscriptionDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

export interface UpsertSubscriptionInput {
  readonly planId: string;
  readonly externalId: string;
  readonly processor: string;
  readonly status: string;
  readonly currentPeriodEnd: Date | undefined;
  readonly cancelAtPeriodEnd: boolean;
}

export class SubscriptionRepository {
  readonly #collection: ScopedCollection<SubscriptionDoc>;

  constructor(db: Db, workspaceId: string) {
    this.#collection = new ScopedDb(db, workspaceId).collection<SubscriptionDoc>('subscriptions');
  }

  async current(): Promise<SubscriptionDoc | null> {
    return this.#collection.findOne({} as never);
  }

  /**
   * Records what the processor says.
   *
   * Upserted on the workspace, because there is exactly one subscription per
   * workspace and a second row would mean the platform disagreeing with itself
   * about what somebody is paying for.
   */
  async record(input: UpsertSubscriptionInput): Promise<void> {
    const now = new Date();
    await this.#collection.updateOne(
      {} as never,
      {
        $set: {
          planId: input.planId,
          externalId: input.externalId,
          processor: input.processor,
          status: input.status,
          currentPeriodEnd: input.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd,
          updatedAt: now,
        },
        $setOnInsert: { _id: newId(IdPrefix.subscription), createdAt: now },
      } as never,
      { upsert: true },
    );
  }

  async markEnded(): Promise<void> {
    await this.#collection.updateOne(
      {} as never,
      { $set: { status: 'ended', updatedAt: new Date() } } as never,
    );
  }
}
