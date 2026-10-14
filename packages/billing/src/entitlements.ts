/**
 * What a workspace is allowed to do.
 *
 * Three ways in: a subscription the processor confirmed, a free trial the
 * workspace started itself, or an exemption the operator granted. Nothing
 * else runs an assistant. A trial is ten days from the click, no card asked
 * for, and it is used once.
 *
 * What a failed payment does: nothing yet. `past_due` keeps working while the
 * processor retries, typically for days, because a card that expired on a
 * Sunday should not stop an agent somebody's work depends on.
 */
import { planById, DEFAULT_PLAN_ID, type Plan } from '@salvations/catalog';
import type { Subscription } from './port';

/** How long a free trial lasts, from the moment it is started. */
export const TRIAL_DAYS = 10;

export type EntitlementState =
  /** The operator said so: nothing is counted and nothing refused. */
  | 'exempt'
  | 'subscribed'
  | 'trial'
  | 'trial_ended'
  /** Never subscribed, never started a trial. */
  | 'none';

export interface Entitlements {
  readonly planId: string | undefined;
  readonly active: boolean;
  readonly limits: Plan['limits'] | undefined;
  /** True for an exempt workspace: nothing is counted and nothing refused. */
  readonly unconfigured: boolean;
  readonly state: EntitlementState;
  /** Present during a trial, and after one, so the page can say when. */
  readonly trialEndsAt?: Date;
}

/** An exempt workspace. The name is historical; the meaning is "refuse nobody". */
export const UNCONFIGURED: Entitlements = Object.freeze({
  planId: undefined,
  active: true,
  limits: undefined,
  unconfigured: true,
  state: 'exempt',
});

export const NONE: Entitlements = Object.freeze({
  planId: undefined, active: false, limits: undefined, unconfigured: false, state: 'none',
});

export function entitlementsOf(subscription: Subscription | undefined): Entitlements {
  if (subscription === undefined) return NONE;

  const plan = planById(subscription.planId);
  // `past_due` is deliberately here. The processor is still retrying, and
  // cutting access on the first failed charge turns an expired card into an
  // outage for everything that depends on the agent.
  const active = subscription.status === 'active'
    || subscription.status === 'cancelling'
    || subscription.status === 'past_due';
  return {
    planId: subscription.planId,
    active,
    limits: plan?.limits,
    unconfigured: false,
    state: active ? 'subscribed' : 'none',
  };
}

/**
 * A trial, while it lasts.
 *
 * It grants the default plan's limits, so what somebody builds in ten days is
 * what the plan will hold afterwards, and nothing has to be taken away on the
 * day they pay.
 */
export function trialEntitlements(trial: { readonly endsAt: Date }, now: Date = new Date()): Entitlements {
  const plan = planById(DEFAULT_PLAN_ID);
  const live = trial.endsAt.getTime() > now.getTime();
  return {
    planId: live ? DEFAULT_PLAN_ID : undefined,
    active: live,
    limits: live ? plan?.limits : undefined,
    unconfigured: false,
    state: live ? 'trial' : 'trial_ended',
    trialEndsAt: trial.endsAt,
  };
}

/** Why a workspace may not run, said the way the page would say it. */
export function inactiveReason(entitlements: Entitlements): string {
  switch (entitlements.state) {
    case 'trial_ended':
      return `Your ${TRIAL_DAYS}-day free trial has ended. Choose a plan on the Billing page to keep going.`;
    case 'none':
      return `Start your ${TRIAL_DAYS}-day free trial or choose a plan on the Billing page.`;
    default:
      return 'This workspace has no active subscription. Choose a plan on the Billing page.';
  }
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
    return { allowed: false, reason: inactiveReason(entitlements) };
  }

  const ceiling = entitlements.limits?.[limit];
  if (ceiling === undefined) return ALLOWED;
  if (current < ceiling) return ALLOWED;

  return {
    allowed: false,
    reason: `Your plan includes ${ceiling} ${String(limit)}. You have ${current}.`,
  };
}
