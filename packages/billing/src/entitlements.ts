/**
 * What a workspace is allowed to do.
 *
 * The important decision here is what happens when billing is NOT configured,
 * and the answer is: everything is allowed.
 *
 * A deployment with no processor set up is one where nobody has been asked to
 * pay and nobody has agreed to. Locking those people out of their own agents
 * and their own data would be a self-inflicted outage dressed up as a
 * safeguard. So `unconfigured` grants everything, and only a deployment that
 * has actually been wired to a processor can refuse anything.
 *
 * The second decision is what a failed payment does, and the answer is: nothing
 * yet. `past_due` keeps working while the processor retries — typically for
 * days — because a card that expired on a Sunday should not stop an agent
 * somebody's work depends on.
 */
import { planById, type Plan } from '@salvations/catalog';
import type { Subscription } from './port';

export interface Entitlements {
  readonly planId: string | undefined;
  readonly active: boolean;
  readonly limits: Plan['limits'] | undefined;
  /** True when this deployment cannot charge anybody, so it refuses nobody. */
  readonly unconfigured: boolean;
}

export const UNCONFIGURED: Entitlements = Object.freeze({
  planId: undefined,
  active: true,
  limits: undefined,
  unconfigured: true,
});

export function entitlementsOf(subscription: Subscription | undefined): Entitlements {
  if (subscription === undefined) {
    return { planId: undefined, active: false, limits: undefined, unconfigured: false };
  }

  const plan = planById(subscription.planId);
  return {
    planId: subscription.planId,
    // `past_due` is deliberately here. The processor is still retrying, and
    // cutting access on the first failed charge turns an expired card into an
    // outage for everything that depends on the agent.
    active: subscription.status === 'active'
      || subscription.status === 'cancelling'
      || subscription.status === 'past_due',
    limits: plan?.limits,
    unconfigured: false,
  };
}

export type LimitName = keyof Plan['limits'];

export interface LimitCheck {
  readonly allowed: boolean;
  readonly reason: string | undefined;
}

const ALLOWED: LimitCheck = Object.freeze({ allowed: true, reason: undefined });

/**
 * Whether one more of something is permitted.
 *
 * `current` is what already exists, so the caller asks before creating rather
 * than discovering afterwards. Unlimited is expressed as an absent limit, never
 * as a sentinel like -1: a sentinel compared with `<` silently allows nothing.
 */
export function withinLimit(
  entitlements: Entitlements,
  limit: LimitName,
  current: number,
): LimitCheck {
  if (entitlements.unconfigured) return ALLOWED;

  if (!entitlements.active) {
    return { allowed: false, reason: 'This workspace has no active subscription.' };
  }

  const ceiling = entitlements.limits?.[limit];
  if (ceiling === undefined) return ALLOWED;
  if (current < ceiling) return ALLOWED;

  return {
    allowed: false,
    reason: `Your plan includes ${ceiling} ${String(limit)}. You have ${current}.`,
  };
}
