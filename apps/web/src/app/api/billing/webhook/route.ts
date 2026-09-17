/**
 * Where the payment processor tells us what happened.
 *
 * Outside the session-authenticated API, like the chat webhooks and for the
 * same reason: the caller has no cookie and authenticates by signing. The
 * adapter checks the signature and the timestamp before anything here acts.
 *
 * The processor's record is the source of truth and this endpoint is how it
 * reaches us, so a failure must be a 500 — the processor retries for days, and
 * a 200 over a failed write would leave somebody charged and locked out with no
 * second chance to notice.
 */
import { SubscriptionRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { processor } from '@/lib/billing';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const gateway = processor();
  if (gateway === undefined) {
    // Nothing is configured, so nothing can legitimately be delivering here.
    return new Response('not configured', { status: 404 });
  }

  // Bytes, not parsed JSON: the signature is over the bytes.
  const raw = await request.text();
  const event = await gateway.receive(raw, request.headers);

  switch (event.kind) {
    case 'rejected':
      return new Response('unauthorized', { status: 401 });

    case 'ignored':
      // 200. A processor that gets an error for an event type we chose not to
      // handle will keep redelivering it and eventually disable the endpoint.
      return new Response('ok', { status: 200 });

    case 'subscription_changed': {
      const handle = await db();
      await new SubscriptionRepository(handle.db, event.reference).record({
        planId: event.subscription.planId,
        externalId: event.subscription.externalId,
        processor: gateway.name,
        status: event.subscription.cancelAtPeriodEnd
          && event.subscription.status === 'active'
          ? 'cancelling'
          : event.subscription.status,
        currentPeriodEnd: event.subscription.currentPeriodEnd,
        cancelAtPeriodEnd: event.subscription.cancelAtPeriodEnd,
      });
      return new Response('ok', { status: 200 });
    }

    case 'subscription_ended': {
      const handle = await db();
      await new SubscriptionRepository(handle.db, event.reference).markEnded();
      return new Response('ok', { status: 200 });
    }
  }
}
