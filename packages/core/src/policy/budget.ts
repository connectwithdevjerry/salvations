/**
 * Budget accounting. Enforced by the runtime, independent of any vendor feature.
 */
import type { RunBudget, RunConsumption } from '../entities/run';

export type BudgetBreach =
  | 'max_steps' | 'max_tool_calls' | 'max_tokens'
  | 'max_wall_clock' | 'max_cost';

export function checkBudget(
  budget: RunBudget,
  consumed: RunConsumption,
): BudgetBreach | undefined {
  if (consumed.steps >= budget.maxSteps) return 'max_steps';
  if (consumed.toolCalls >= budget.maxToolCalls) return 'max_tool_calls';
  if (consumed.tokens >= budget.maxTotalTokens) return 'max_tokens';
  if (consumed.wallClockMs >= budget.maxWallClockMs) return 'max_wall_clock';
  if (consumed.costUsd >= budget.maxCostUsd) return 'max_cost';
  return undefined;
}

export const budgetRemaining = (budget: RunBudget, consumed: RunConsumption) => ({
  steps: Math.max(0, budget.maxSteps - consumed.steps),
  toolCalls: Math.max(0, budget.maxToolCalls - consumed.toolCalls),
  tokens: Math.max(0, budget.maxTotalTokens - consumed.tokens),
  wallClockMs: Math.max(0, budget.maxWallClockMs - consumed.wallClockMs),
  costUsd: Math.max(0, budget.maxCostUsd - consumed.costUsd),
});

/** Cost from token usage and per-million rates. */
export function computeCostUsd(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  rates: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number },
): number {
  const M = 1_000_000;
  const cacheRead = rates.cacheReadPerMTok ?? rates.inputPerMTok;
  const cacheWrite = rates.cacheWritePerMTok ?? rates.inputPerMTok;
  return (
    (usage.inputTokens * rates.inputPerMTok +
      usage.outputTokens * rates.outputPerMTok +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) / M
  );
}

/**
 * Narrows a budget to what a caller is allowed to ask for.
 *
 * Every field takes the MINIMUM of what was requested and the ceiling. A caller
 * can ask for less than the ceiling — a cheap exploratory run — and cannot ask
 * for more, which is the whole point: a budget a client can raise is not a
 * budget, and validating the request shape alone does not stop that, because a
 * schema bound is still a number the client chose.
 */
export function clampBudget(
  // Deliberately permits `undefined` per field: a parsed request body has
  // optional keys present and unset, and a stricter type here would push a cast
  // to every caller.
  requested: { readonly [K in keyof RunBudget]?: number | undefined } | undefined,
  ceiling: RunBudget,
): RunBudget {
  const pick = (key: keyof RunBudget): number => {
    const value = requested?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.min(value, ceiling[key])
      : ceiling[key];
  };

  return {
    maxSteps: pick('maxSteps'),
    maxToolCalls: pick('maxToolCalls'),
    maxTotalTokens: pick('maxTotalTokens'),
    maxWallClockMs: pick('maxWallClockMs'),
    maxCostUsd: pick('maxCostUsd'),
    maxMrtrRounds: pick('maxMrtrRounds'),
    maxSubagentDepth: pick('maxSubagentDepth'),
  };
}
