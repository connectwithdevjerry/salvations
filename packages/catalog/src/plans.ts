/**
 * What HIVE costs.
 *
 * Hard-coded for the same reason the integrations are: a price is a promise,
 * and a promise assembled at runtime from a vendor's API is one nobody can read
 * in the source. The processor is told these numbers; it does not define them.
 *
 * `priceId` is the processor's own identifier for the same price. It is the one
 * field here that is not ours, and it is configuration rather than a constant
 * because the same plan has a different id in test and in production — hard
 * coding it is how a test key ends up charging a real customer, or a deploy
 * silently sells nothing.
 */
export interface Plan {
  readonly id: string;
  readonly name: string;
  /** In cents, to avoid ever holding money in a float. */
  readonly amountCents: number;
  readonly currency: string;
  readonly interval: 'month' | 'year';
  readonly tagline: string;
  readonly features: readonly string[];
  /**
   * What the plan permits. Checked by the entitlement layer, which fails OPEN
   * when no processor is configured — a deployment with no billing set up is a
   * deployment where nobody has agreed to be charged, and locking those people
   * out of their own data would be the wrong failure.
   */
  readonly limits: {
    readonly agents: number;
    readonly channels: number;
    readonly mcpServers: number;
    /** A ceiling on spend the platform enforces, independent of the vendor. */
    readonly monthlyUsdCap: number;
  };
}

export const PLANS: readonly Plan[] = [
  {
    id: 'standard',
    name: 'Standard',
    amountCents: 6_700,
    currency: 'usd',
    interval: 'month',
    tagline: 'One subscription, agents that stay online.',
    features: [
      'Agents run on their own schedule, not only while a tab is open',
      'Work asynchronously — hand over a task, come back to the result',
      'As many automations as you want',
      'Talk to them here, on Telegram, Discord or Slack',
      'Connect the tools they work in — email, calendar and the rest',
    ],
    limits: { agents: 25, channels: 10, mcpServers: 50, monthlyUsdCap: 250 },
  },
];

export const planById = (id: string): Plan | undefined => PLANS.find((p) => p.id === id);

export const DEFAULT_PLAN_ID = 'standard';

/** Formats a price the way it will be charged, not the way it is stored. */
export const formatPrice = (plan: Plan): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: plan.currency.toUpperCase(),
    // A whole-dollar price should read "$67", not "$67.00"; anything else keeps
    // its cents.
    minimumFractionDigits: plan.amountCents % 100 === 0 ? 0 : 2,
  }).format(plan.amountCents / 100);
