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
import { SubscriptionRepository, UserRepository, WorkspaceRepository, type Database, type WorkspaceDoc } from '@salvations/db';
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
 * In order: the operator's exemption (the workspace's, or its owner's), a
 * subscription the processor confirmed, the free trial. A subscription only
 * exists where a processor does, so an unbilled deployment pays for one
 * workspace read and no more.
 */
export async function entitlements(
  database: Database,
  workspaceId: string,
): Promise<Entitlements> {
  if (env().COMPLIMENTARY_WORKSPACES.has(workspaceId)) return UNCONFIGURED;
  const workspace = await new WorkspaceRepository(database).findById(workspaceId);
  if (workspace !== null && await ownedByComplimentary(database, workspace)) return UNCONFIGURED;

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

  const trial = workspace?.trial;
  if (trial !== null && trial !== undefined) return trialEntitlements({ endsAt: trial.endsAt });
  return NONE;
}

/**
 * Whether an active owner of the workspace is on the operator's list of people
 * never asked to pay. Only a verified address counts: anyone can sign up with
 * an address, and only its owner can verify it.
 */
async function ownedByComplimentary(database: Database, workspace: WorkspaceDoc): Promise<boolean> {
  const comped = env().COMPLIMENTARY_EMAILS;
  if (comped.size === 0) return false;
  const users = new UserRepository(database);
  for (const member of workspace.members) {
    if (member.role !== 'owner' || member.status !== 'active') continue;
    const user = await users.findById(member.userId);
    if (user !== null && user.emailVerifiedAt != null && comped.has(user.email.toLowerCase())) return true;
  }
  return false;
}
