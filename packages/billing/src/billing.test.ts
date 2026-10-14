import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStripeProcessor, encodeForm } from './stripe';
import { entitlementsOf, trialEntitlements, withinLimit, TRIAL_DAYS, UNCONFIGURED } from './entitlements';
import type { Subscription } from './port';

const SECRET = 'whsec_test';
const processor = createStripeProcessor({ secretKey: 'sk_test', webhookSecret: SECRET });

const signed = (body: string, timestamp = Math.floor(Date.now() / 1000), secret = SECRET) => {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return new Headers({ 'stripe-signature': `t=${timestamp},v1=${digest}` });
};

const subscriptionEvent = (type: string, over: Record<string, unknown> = {}) => JSON.stringify({
  type,
  data: {
    object: {
      id: 'sub_1',
      status: 'active',
      current_period_end: 1_800_000_000,
      metadata: { reference: 'wks_1', planId: 'standard' },
      ...over,
    },
  },
});

describe('form encoding', () => {
  it('brackets nested values the way Stripe expects', () => {
    // Sending JSON, or flattening this wrongly, gets a 400 that does not say
    // which field was at fault.
    expect(encodeForm({ metadata: { reference: 'wks_1' } }))
      .toBe('metadata%5Breference%5D=wks_1');
  });

  it('indexes arrays of objects', () => {
    expect(encodeForm({ line_items: [{ price: 'price_1', quantity: 1 }] }))
      .toBe('line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1');
  });

  it('drops undefined rather than sending the string "undefined"', () => {
    // `customer_email: undefined` is normal here, and Stripe rejects the
    // literal string as an invalid address.
    expect(encodeForm({ a: 1, b: undefined })).toBe('a=1');
  });
});

describe('webhook verification', () => {
  it('rejects an unsigned delivery', () => {
    expect(processor.receive(subscriptionEvent('customer.subscription.updated'), new Headers()))
      .toMatchObject({ kind: 'rejected' });
  });

  it('rejects a signature made with a different secret', () => {
    const body = subscriptionEvent('customer.subscription.updated');
    expect(processor.receive(body, signed(body, undefined, 'whsec_wrong')))
      .toMatchObject({ kind: 'rejected' });
  });

  it('rejects a correctly signed but stale delivery', () => {
    // The signature verifies; the body is two hours old. Checking the signature
    // alone would accept a replay.
    const body = subscriptionEvent('customer.subscription.updated');
    const stale = Math.floor(Date.now() / 1000) - 7200;
    expect(processor.receive(body, signed(body, stale)))
      .toEqual({ kind: 'rejected', reason: 'The delivery is too old to accept.' });
  });

  it('accepts when any one of several signatures verifies', () => {
    // During a secret rotation Stripe sends more than one v1. Taking only the
    // first would drop every event for the length of the rotation.
    const body = subscriptionEvent('customer.subscription.updated');
    const timestamp = Math.floor(Date.now() / 1000);
    const good = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    const headers = new Headers({
      'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)},v1=${good}`,
    });
    expect(processor.receive(body, headers)).toMatchObject({ kind: 'subscription_changed' });
  });

  it('reads a subscription update into our own shape', () => {
    const body = subscriptionEvent('customer.subscription.updated');
    expect(processor.receive(body, signed(body))).toEqual({
      kind: 'subscription_changed',
      reference: 'wks_1',
      subscription: {
        externalId: 'sub_1',
        planId: 'standard',
        status: 'active',
        currentPeriodEnd: new Date(1_800_000_000 * 1000),
        cancelAtPeriodEnd: false,
      },
    });
  });

  it('maps a status it has never seen to ended rather than active', () => {
    // Failing open on an unrecognised status would keep a cancelled workspace
    // running indefinitely.
    const body = subscriptionEvent('customer.subscription.updated', { status: 'something_new' });
    expect(processor.receive(body, signed(body)))
      .toMatchObject({ subscription: { status: 'ended' } });
  });

  it('ignores an event type it does not handle', () => {
    // Stripe sends dozens. A new one must never be an error.
    const body = subscriptionEvent('invoice.payment_succeeded');
    expect(processor.receive(body, signed(body))).toMatchObject({ kind: 'ignored' });
  });

  it('ignores an event carrying no workspace reference', () => {
    const body = subscriptionEvent('customer.subscription.updated', { metadata: {} });
    expect(processor.receive(body, signed(body))).toMatchObject({ kind: 'ignored' });
  });
});

describe('entitlements', () => {
  const subscription = (over: Partial<Subscription> = {}): Subscription => ({
    externalId: 'sub_1', planId: 'standard', status: 'active',
    currentPeriodEnd: undefined, cancelAtPeriodEnd: false, ...over,
  });

  it('allows everything for an exempt workspace', () => {
    expect(withinLimit(UNCONFIGURED, 'agents', 10_000).allowed).toBe(true);
    expect(UNCONFIGURED.state).toBe('exempt');
  });

  it('grants the default plan during a trial, and nothing after it', () => {
    const endsAt = new Date('2026-10-24T00:00:00Z');
    const during = trialEntitlements({ endsAt }, new Date('2026-10-20T00:00:00Z'));
    expect(during.active).toBe(true);
    expect(during.state).toBe('trial');
    expect(during.limits?.agents).toBeGreaterThan(0);
    expect(withinLimit(during, 'agents', 0).allowed).toBe(true);

    const after = trialEntitlements({ endsAt }, new Date('2026-10-24T00:00:01Z'));
    expect(after.active).toBe(false);
    expect(after.state).toBe('trial_ended');
    expect(withinLimit(after, 'agents', 0).reason).toMatch(/free trial has ended/);
  });

  it('tells a workspace that never started what to do', () => {
    expect(withinLimit(entitlementsOf(undefined), 'agents', 0).reason).toMatch(/Start your 10-day free trial/);
    expect(TRIAL_DAYS).toBe(10);
  });

  it('keeps a past_due workspace running', () => {
    // The processor is still retrying. Cutting access on the first failed
    // charge turns an expired card into an outage.
    expect(entitlementsOf(subscription({ status: 'past_due' })).active).toBe(true);
  });

  it('keeps a cancelling workspace running until the period ends', () => {
    expect(entitlementsOf(subscription({ status: 'cancelling' })).active).toBe(true);
  });

  it('stops an ended workspace', () => {
    expect(entitlementsOf(subscription({ status: 'ended' })).active).toBe(false);
  });

  it('refuses a workspace with no subscription at all', () => {
    const none = entitlementsOf(undefined);
    expect(none.active).toBe(false);
    expect(withinLimit(none, 'agents', 0).allowed).toBe(false);
  });

  it('allows up to the limit and not past it', () => {
    const active = entitlementsOf(subscription());
    const ceiling = active.limits?.agents ?? 0;

    expect(withinLimit(active, 'agents', ceiling - 1).allowed).toBe(true);
    // At the ceiling, not over it: `current` is what already exists, so being
    // AT the limit means the next one would exceed it.
    expect(withinLimit(active, 'agents', ceiling).allowed).toBe(false);
    expect(withinLimit(active, 'agents', ceiling).reason).toContain(String(ceiling));
  });
});

describe('customer portal', () => {
  it('finds the customer behind the subscription and opens their portal', async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), body: init?.body === undefined ? undefined : String(init.body) });
      if (String(url).endsWith('/subscriptions/sub_1')) {
        return Response.json({ id: 'sub_1', status: 'active', customer: 'cus_9' });
      }
      return Response.json({ url: 'https://billing.stripe.com/session/x' });
    };
    const stripe = createStripeProcessor({ secretKey: 'sk_test', webhookSecret: SECRET, fetch: fake as typeof fetch });
    const url = await stripe.portalUrl('sub_1', 'https://hive.example/w/wks_1/billing');
    expect(url).toBe('https://billing.stripe.com/session/x');
    expect(calls[1]?.url).toContain('/billing_portal/sessions');
    expect(calls[1]?.body).toContain('customer=cus_9');
    expect(calls[1]?.body).toContain('return_url=');
  });

  it('says so when the subscription has no customer', async () => {
    const fake = async (): Promise<Response> => Response.json({ id: 'sub_1', status: 'active' });
    const stripe = createStripeProcessor({ secretKey: 'sk_test', webhookSecret: SECRET, fetch: fake as typeof fetch });
    await expect(stripe.portalUrl('sub_1', 'https://hive.example')).rejects.toThrow(/no customer/);
  });
});
