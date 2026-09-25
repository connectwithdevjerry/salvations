/**
 * Stripe, over its REST API.
 *
 * No SDK, for the same reasons as the Google OIDC client: the surface used here
 * is four endpoints and one signature check, and a package that ships its own
 * HTTP stack, its own retry policy and its own types is a large dependency to
 * carry for that.
 *
 * Stripe's API is form-encoded, not JSON, which is easy to get wrong in a way
 * that fails only for nested values — hence the explicit encoder below.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BillingError,
  type BillingEvent, type CheckoutRequest, type CheckoutSession,
  type PaymentProcessor, type Subscription, type SubscriptionStatus,
} from './port';

const API = 'https://api.stripe.com/v1';

const SIGNATURE_HEADER = 'stripe-signature';

/** How stale a delivery may be. Stripe's own recommendation. */
export const MAX_SKEW_SECONDS = 300;

/** Stripe's statuses, mapped to ours. Anything unknown is treated as ended. */
const STATUS: Readonly<Record<string, SubscriptionStatus>> = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  incomplete: 'incomplete',
  incomplete_expired: 'ended',
  canceled: 'ended',
  paused: 'ended',
};

/**
 * Stripe takes application/x-www-form-urlencoded with bracketed paths for
 * nesting: `items[0][price]=price_x`. Sending JSON gets a 400 that does not say
 * why.
 */
function form(values: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const path = prefix === '' ? key : `${prefix}[${key}]`;
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(form(value as Record<string, unknown>, path));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        parts.push(typeof item === 'object'
          ? form(item as Record<string, unknown>, `${path}[${index}]`)
          : `${encodeURIComponent(`${path}[${index}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else {
      parts.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter((p) => p !== '').join('&');
}

interface StripeSubscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items?: { data?: { price?: { id?: string } }[] };
}

export interface StripeConfig {
  readonly secretKey: string;
  /** From the webhook endpoint's own page. Not the secret key. */
  readonly webhookSecret: string;
  readonly fetch?: typeof fetch;
}

export function createStripeProcessor(config: StripeConfig): PaymentProcessor {
  const fetchImpl = config.fetch ?? globalThis.fetch;

  async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/x-www-form-urlencoded' }),
        },
        ...(body === undefined ? {} : { body: form(body) }),
      });
    } catch (caught) {
      throw new BillingError(`Could not reach the payment processor: ${String(caught)}`);
    }

    const parsed = await response.json().catch(() => undefined) as
      { error?: { message?: string } } | undefined;

    if (!response.ok) {
      // Stripe's own message names the actual problem ("No such price"), which
      // is far more use than anything invented here.
      throw new BillingError(
        parsed?.error?.message ?? `The payment processor refused the request (${response.status}).`,
        response.status,
      );
    }
    return parsed as T;
  }

  const toSubscription = (row: StripeSubscription, planId: string): Subscription => ({
    externalId: row.id,
    planId,
    status: STATUS[row.status] ?? 'ended',
    currentPeriodEnd: row.current_period_end === undefined
      ? undefined
      : new Date(row.current_period_end * 1000),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
  });

  return {
    name: 'stripe',

    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
      const session = await call<{ id: string; url?: string }>('/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: request.priceId, quantity: 1 }],
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        customer_email: request.customerEmail,
        // On BOTH the session and the subscription. The session's metadata does
        // not carry over on its own, and webhooks about the subscription are
        // the ones that arrive months later — by which time the session is long
        // gone and there would be nothing left tying the payment to a workspace.
        metadata: { reference: request.reference, planId: request.planId },
        subscription_data: {
          metadata: { reference: request.reference, planId: request.planId },
        },
      });

      if (session.url === undefined) {
        throw new BillingError('The payment processor did not return a checkout URL.');
      }
      return { id: session.id, url: session.url };
    },

    async cancel(externalId: string): Promise<Subscription> {
      // At period end, never immediately: somebody who has paid for this month
      // keeps this month.
      const row = await call<StripeSubscription>(`/subscriptions/${externalId}`, {
        cancel_at_period_end: true,
      });
      return toSubscription(row, row.metadata?.['planId'] ?? 'standard');
    },

    async fetch(externalId: string): Promise<Subscription | undefined> {
      try {
        const row = await call<StripeSubscription>(`/subscriptions/${externalId}`);
        return toSubscription(row, row.metadata?.['planId'] ?? 'standard');
      } catch (caught) {
        if (caught instanceof BillingError && caught.status === 404) return undefined;
        throw caught;
      }
    },

    receive(raw: string, headers: Headers): BillingEvent {
      const header = headers.get(SIGNATURE_HEADER);
      if (header === null) return { kind: 'rejected', reason: 'The delivery was not signed.' };

      // `t=1234,v1=abc,v1=def` — more than one v1 during a secret rotation, and
      // any of them verifying is enough.
      const parts = header.split(',').map((p) => p.trim().split('='));
      const timestamp = parts.find(([k]) => k === 't')?.[1];
      const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
      if (timestamp === undefined || signatures.length === 0) {
        return { kind: 'rejected', reason: 'The signature header was malformed.' };
      }

      const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
      if (!Number.isFinite(age) || age > MAX_SKEW_SECONDS) {
        // A correct signature over an old body is still a replay.
        return { kind: 'rejected', reason: 'The delivery is too old to accept.' };
      }

      const expected = createHmac('sha256', config.webhookSecret)
        .update(`${timestamp}.${raw}`)
        .digest('hex');
      const computed = Buffer.from(expected, 'utf8');
      const matched = signatures.some((candidate) => {
        const presented = Buffer.from(candidate, 'utf8');
        return presented.length === computed.length && timingSafeEqual(presented, computed);
      });
      if (!matched) return { kind: 'rejected', reason: 'The signature did not verify.' };

      let event: { type?: string; data?: { object?: StripeSubscription } };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        return { kind: 'rejected', reason: 'The delivery was not JSON.' };
      }

      const object = event.data?.object;
      const reference = object?.metadata?.['reference'];
      if (object === undefined || reference === undefined) {
        return { kind: 'ignored', reason: 'Nothing that names a workspace.' };
      }

      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          return {
            kind: 'subscription_changed',
            reference,
            subscription: toSubscription(object, object.metadata?.['planId'] ?? 'standard'),
          };
        case 'customer.subscription.deleted':
          return { kind: 'subscription_ended', reference };
        default:
          // Stripe sends dozens of event types and adding one must never be an
          // error here.
          return { kind: 'ignored', reason: `Event type ${event.type ?? 'unknown'}.` };
      }
    },
  };
}

export { form as encodeForm };
