/**
 * This deployment's payment processor, if it has one.
 *
 * Returns undefined rather than throwing when billing is not configured. Then
 * nobody can pay, and the plan page says so; a free trial still starts, and
 * an exempt workspace still runs.
 */
import {
  createStripeProcessor, entitlementsOf, trialEntitlements, NONE, UNCONFIGURED,
  type Entitlements, type PaymentProcessor,
} from '@salvations/billing';
import { SubscriptionRepository, WorkspaceRepository, type Database } from '@salvations/db';
import { env } from './env';

let cached: PaymentProcessor | undefined;

export function processor(): PaymentProcessor | undefined {
  const configured = env();
  if (
    configured.STRIPE_SECRET_KEY === undefined
    || configured.STRIPE_WEBHOOK_SECRET === undefined
  ) {
    return undefined;
  }
  cached ??= createStripeProcessor({
    secretKey: configured.STRIPE_SECRET_KEY,
    webhookSecret: configured.STRIPE_WEBHOOK_SECRET,
  });
  return cached;
}

export const billingConfigured = (): boolean => processor() !== undefined;

export const priceId = (): string | undefined => env().STRIPE_PRICE_ID;

/**
 * What this workspace may do.
 *
 * In order: the operator's exemption, a subscription the processor confirmed,
 * the free trial. A subscription only exists where a processor does, so an
 * unbilled deployment pays for one workspace read and no more.
 */
export async function entitlements(
  database: Database,
  workspaceId: string,
): Promise<Entitlements> {
  if (env().COMPLIMENTARY_WORKSPACES.has(workspaceId)) return UNCONFIGURED;

  if (billingConfigured()) {
    const row = await new SubscriptionRepository(database, workspaceId).current();
    if (row !== null) {
      const subscribed = entitlementsOf({
        externalId: row.externalId,
        planId: row.planId,
        status: row.status as never,
        currentPeriodEnd: row.currentPeriodEnd ?? undefined,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      });
      if (subscribed.active) return subscribed;
    }
  }

  const workspace = await new WorkspaceRepository(database).findById(workspaceId);
  const trial = workspace?.trial;
  if (trial !== null && trial !== undefined) return trialEntitlements({ endsAt: trial.endsAt });
  return NONE;
}
