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
