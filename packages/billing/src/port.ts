/**
 * Taking money.
 *
 * A port, for the same reason the model providers are one: the processor is a
 * vendor, and a vendor written into the pages that use it is a vendor you
 * cannot change. Nothing above this file knows what Stripe is.
 *
 * Card details never reach this codebase. The processor hosts the form, the
 * browser goes there, and what comes back is an identifier — which is not a
 * design preference. Handling a raw card number puts a system in PCI-DSS scope
 * as a whole, and no amount of care in this repository would take it back out.
 */

export type SubscriptionStatus =
  /** Paid and current. */
  | 'active'
  /** Paid, but the person has asked it to stop at the end of the period. */
  | 'cancelling'
  /** A payment failed. Access continues while the processor retries. */
  | 'past_due'
  /** Over, whether cancelled or abandoned. */
  | 'ended'
  /** Checkout was started and never finished. */
  | 'incomplete';

export interface Subscription {
  /** The processor's id. Opaque here, and the only handle on their record. */
  readonly externalId: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date | undefined;
  readonly cancelAtPeriodEnd: boolean;
}

export interface CheckoutRequest {
  readonly planId: string;
  /** The processor's id for this price. Configuration, never a constant. */
  readonly priceId: string;
  /** Ours. Comes back on the webhook and is how a payment finds its workspace. */
  readonly reference: string;
  readonly customerEmail: string | undefined;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface CheckoutSession {
  readonly id: string;
  /** Where to send the browser. The processor's page, never ours. */
  readonly url: string;
}

/** What a processor's webhook turned out to be saying. */
export type BillingEvent =
  | { readonly kind: 'subscription_changed'; readonly reference: string; readonly subscription: Subscription }
  | { readonly kind: 'subscription_ended'; readonly reference: string }
  | { readonly kind: 'ignored'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

export interface PaymentProcessor {
  readonly name: string;

  /** Starts a checkout and returns where to send the person. */
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  /** Stops a subscription at the end of the paid period, never mid-period. */
  cancel(externalId: string): Promise<Subscription>;

  /** Re-reads a subscription, for when a webhook was missed. */
  fetch(externalId: string): Promise<Subscription | undefined>;

  /**
   * Decides what a webhook delivery is.
   *
   * Raw bytes and headers, because the signature is over the bytes — re-
   * serialising parsed JSON does not reproduce them.
   */
  receive(raw: string, headers: Headers): Promise<BillingEvent> | BillingEvent;
}

export class BillingError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BillingError';
    this.status = status;
  }
}
