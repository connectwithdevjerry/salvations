/**
 * What a limit does when it is reached.
 *
 * Three ceilings, one answer each:
 *
 *   - The workspace's own daily spend cap, set by its owner on the admin
 *     dashboard. Reached, no new run starts today; whatever is mid-run
 *     finishes, because stopping a run halfway is worse than one more step.
 *   - The plan's monthly spend cap, when billing is configured. Same rule,
 *     for the month.
 *   - The plan's counts: assistants, channels, connected apps. Reached, the
 *     next one is refused with the number, so the person knows what to
 *     remove or what to ask for.
 *
 * Every refusal is one plain sentence that says which ceiling and where to
 * raise it. None of them touches a run already in flight, and none applies
 * on a deployment that charges nobody.
 */
import { Errors } from '@salvations/core';
import { WorkspaceRepository, type Database } from '@salvations/db';
import { withinLimit, type Entitlements, type LimitName } from '@salvations/billing';
import { entitlements } from './billing';
import { repositories } from './repositories';

export interface Gate {
  readonly allowed: boolean;
  readonly reason?: string;
}

const OPEN: Gate = Object.freeze({ allowed: true });

const usd = (n: number): string => `$${n.toFixed(n < 10 ? 2 : 0)}`;

/** The month a date falls in, as the usage rollup keys it. */
export const monthOf = (when = new Date()): string => when.toISOString().slice(0, 7);

/**
 * Whether one more run may start.
 *
 * Checked where runs are made, not inside the executor: a run that exists
 * has been promised, and the promise is kept. The daily cap is the
 * workspace's own, so it applies on every deployment; the monthly cap is the
 * plan's and applies only where a plan exists.
 */
export async function spendGate(database: Database, workspaceId: string): Promise<Gate> {
  const repos = repositories(database, workspaceId);
  const workspace = await new WorkspaceRepository(database).findById(workspaceId);
  const dailyCap = workspace?.settings.dailyCostCapUsd ?? 0;
  if (dailyCap > 0) {
    const today = await repos.usage.spendOnDay();
    if (today >= dailyCap) {
      return {
        allowed: false,
        reason: `Today's spend has reached the ${usd(dailyCap)} daily cap. Raise it on the admin dashboard, or wait for tomorrow.`,
      };
    }
  }

  const plan = await entitlements(database, workspaceId);
  if (plan.unconfigured) return OPEN;
  if (!plan.active) return { allowed: false, reason: 'This workspace has no active subscription. Choose a plan on the Billing page.' };
  const monthlyCap = plan.limits?.monthlyUsdCap;
  if (monthlyCap !== undefined) {
    const month = await repos.usage.spendInMonth(monthOf());
    if (month >= monthlyCap) {
      return {
        allowed: false,
        reason: `This month's spend has reached the plan's ${usd(monthlyCap)} cap. It resets next month.`,
      };
    }
  }
  return OPEN;
}

/** The same check, thrown: for code paths whose caller maps errors to responses. */
export async function assertSpendAllowed(database: Database, workspaceId: string): Promise<void> {
  const gate = await spendGate(database, workspaceId);
  if (!gate.allowed) throw Errors.budgetExhausted(gate.reason ?? 'The spend cap has been reached.');
}

/**
 * Whether `adding` more of something fits the plan.
 *
 * `current` is what exists already; the caller counts before creating. A
 * team of five against a plan with room for three is refused whole, with
 * the arithmetic, rather than made three-fifths of.
 */
export async function countGate(
  database: Database,
  workspaceId: string,
  limit: LimitName,
  current: number,
  adding = 1,
): Promise<Gate> {
  return countGateFor(await entitlements(database, workspaceId), limit, current, adding);
}

/** The arithmetic on its own, for a plan already in hand. */
export function countGateFor(plan: Entitlements, limit: LimitName, current: number, adding = 1): Gate {
  const check = withinLimit(plan, limit, current + adding - 1);
  if (check.allowed) return OPEN;
  const ceiling = plan.limits?.[limit];
  const noun = NOUNS[limit];
  return {
    allowed: false,
    reason: ceiling === undefined
      ? check.reason ?? 'This is not included in your plan.'
      : adding > 1
        ? `Your plan includes ${ceiling} ${noun}. You have ${current}, and this would add ${adding}.`
        : `Your plan includes ${ceiling} ${noun}, and you have ${current}. Remove one, or ask for a larger plan.`,
  };
}

const NOUNS: Readonly<Record<LimitName, string>> = {
  agents: 'assistants',
  channels: 'channels',
  mcpServers: 'connected apps',
  monthlyUsdCap: 'dollars a month',
};
