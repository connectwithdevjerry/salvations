/**
 * The processor's own page for the card on file and the invoices.
 *
 * Nothing about a card is handled here, which is the point: the person goes
 * to the processor, changes what they need, and comes back to the billing
 * page. There is a subscription or there is no portal.
 */
import { BillingError } from '@salvations/billing';
import { SubscriptionRepository } from '@salvations/db';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { processor } from '@/lib/billing';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

export const POST = workspaceRoute('workspace:manage', async (ctx) => {
  const gateway = processor();
  if (gateway === undefined) return errorResponse(501, 'unsupported', 'No payment processor is configured.');

  const row = await new SubscriptionRepository(ctx.database, ctx.workspaceId).current();
  if (row === null) return errorResponse(404, 'not_found', 'There is no subscription to manage yet.');

  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');
  try {
    const url = await gateway.portalUrl(row.externalId, `${base}/w/${ctx.workspaceId}/billing`);
    return ok({ url }, 201);
  } catch (caught) {
    return errorResponse(502, 'upstream', caught instanceof BillingError ? caught.message : 'The payment processor refused.');
  }
});
