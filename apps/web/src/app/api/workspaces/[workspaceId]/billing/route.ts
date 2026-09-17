/**
 * What this workspace is paying for, and how to start or stop.
 *
 * GET is safe to call from any page: when no processor is configured it says so
 * and reports everything as permitted, which is how the UI knows to hide the
 * subject entirely rather than showing a broken upgrade button.
 */
import { PLANS, planById, DEFAULT_PLAN_ID } from '@salvations/catalog';
import { BillingError } from '@salvations/billing';
import { SubscriptionRepository, UserRepository } from '@salvations/db';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { billingConfigured, entitlements, priceId, processor } from '@/lib/billing';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

export const GET = workspaceRoute('workspace:read', async (ctx) => {
  const granted = await entitlements(ctx.database, ctx.workspaceId);
  const row = await new SubscriptionRepository(ctx.database, ctx.workspaceId).current();

  return ok({
    configured: billingConfigured(),
    plans: PLANS,
    active: granted.active,
    planId: granted.planId,
    ...(row !== null ? {
      subscription: {
        status: row.status,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        currentPeriodEnd: row.currentPeriodEnd?.toISOString(),
      },
    } : {}),
  });
});

/** Starts a checkout and hands back where to send the browser. */
export const POST = workspaceRoute('workspace:manage', async (ctx) => {
  const gateway = processor();
  const price = priceId();
  if (gateway === undefined || price === undefined) {
    return errorResponse(
      501, 'unsupported',
      'This deployment has no payment processor configured, so there is nothing to buy.',
    );
  }

  const plan = planById(DEFAULT_PLAN_ID);
  if (plan === undefined) return errorResponse(500, 'internal', 'The plan is missing.');

  // Prefilled so somebody is not asked for an address we already know. An API
  // key has no person behind it, so there is simply nothing to prefill there.
  const user = ctx.principal.type === 'user'
    ? await new UserRepository(ctx.database).findById(String(ctx.principal.userId))
    : null;

  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');
  try {
    const session = await gateway.createCheckout({
      planId: plan.id,
      priceId: price,
      // OUR id, carried through the processor and returned on the webhook. It
      // is the only thing tying a payment months later back to a workspace.
      reference: ctx.workspaceId,
      customerEmail: user?.emailDisplay ?? user?.email ?? undefined,
      successUrl: `${base}/w/${ctx.workspaceId}/settings?checkout=done`,
      cancelUrl: `${base}/w/${ctx.workspaceId}/billing`,
    });
    return ok({ url: session.url }, 201);
  } catch (caught) {
    return errorResponse(
      502, 'upstream',
      caught instanceof BillingError ? caught.message : 'The payment processor refused.',
    );
  }
});

/** Stops at the end of the paid period. Never mid-period. */
export const DELETE = workspaceRoute('workspace:manage', async (ctx) => {
  const gateway = processor();
  if (gateway === undefined) {
    return errorResponse(501, 'unsupported', 'No payment processor is configured.');
  }

  const subscriptions = new SubscriptionRepository(ctx.database, ctx.workspaceId);
  const row = await subscriptions.current();
  if (row === null) return errorResponse(404, 'not_found', 'Nothing to cancel.');

  try {
    const updated = await gateway.cancel(row.externalId);
    await subscriptions.record({
      planId: updated.planId,
      externalId: updated.externalId,
      processor: gateway.name,
      // 'cancelling', not 'ended': they have paid for this period and keep it.
      status: updated.cancelAtPeriodEnd ? 'cancelling' : updated.status,
      currentPeriodEnd: updated.currentPeriodEnd,
      cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
    });
    return ok({ cancelAtPeriodEnd: true, endsAt: updated.currentPeriodEnd?.toISOString() });
  } catch (caught) {
    return errorResponse(
      502, 'upstream',
      caught instanceof BillingError ? caught.message : 'The payment processor refused.',
    );
  }
});
