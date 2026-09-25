/**
 * This deployment's payment processor, if it has one.
 *
 * Returns undefined rather than throwing when billing is not configured, and
 * every caller is expected to treat that as "charge nobody, refuse nobody". A
 * private install with no processor is a normal thing to be, not an error.
 */
import { createStripeProcessor, entitlementsOf, UNCONFIGURED, type Entitlements, type PaymentProcessor } from '@salvations/billing';
import { SubscriptionRepository, type Database } from '@salvations/db';
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
 * One database read, and only when a processor exists — an unbilled deployment
 * must not pay for a query on every request to discover it still charges
 * nobody.
 */
export async function entitlements(
  database: Database,
  workspaceId: string,
): Promise<Entitlements> {
  if (!billingConfigured()) return UNCONFIGURED;

  const row = await new SubscriptionRepository(database, workspaceId).current();
  if (row === null) return entitlementsOf(undefined);

  return entitlementsOf({
    externalId: row.externalId,
    planId: row.planId,
    status: row.status as never,
    currentPeriodEnd: row.currentPeriodEnd ?? undefined,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  });
}
