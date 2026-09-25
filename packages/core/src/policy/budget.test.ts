import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, emptyConsumption } from '../entities/run';
import { budgetRemaining, checkBudget, clampBudget, computeCostUsd } from './budget';

describe('clamping a requested budget', () => {
  it('lets a caller ask for less', () => {
    // A cheap exploratory run is a legitimate request.
    const budget = clampBudget({ maxSteps: 3, maxCostUsd: 0.1 }, DEFAULT_BUDGET);
    expect(budget.maxSteps).toBe(3);
    expect(budget.maxCostUsd).toBe(0.1);
  });

  it('never lets a caller ask for more', () => {
    // A budget a client can raise is not a budget — and a schema bound is still
    // a number the client chose.
    const budget = clampBudget(
      { maxSteps: 10_000, maxCostUsd: 999, maxTotalTokens: 10 ** 9 }, DEFAULT_BUDGET,
    );
    expect(budget.maxSteps).toBe(DEFAULT_BUDGET.maxSteps);
    expect(budget.maxCostUsd).toBe(DEFAULT_BUDGET.maxCostUsd);
    expect(budget.maxTotalTokens).toBe(DEFAULT_BUDGET.maxTotalTokens);
  });

  it('falls back to the ceiling for anything absent', () => {
    expect(clampBudget(undefined, DEFAULT_BUDGET)).toEqual(DEFAULT_BUDGET);
    expect(clampBudget({}, DEFAULT_BUDGET)).toEqual(DEFAULT_BUDGET);
  });

  it('ignores values that are not usable numbers', () => {
    // A hostile or buggy client must not be able to produce NaN limits, which
    // compare false against everything and disable the check entirely.
    const budget = clampBudget(
      { maxSteps: Number.NaN, maxCostUsd: -5, maxTotalTokens: Number.POSITIVE_INFINITY },
      DEFAULT_BUDGET,
    );
    expect(budget.maxSteps).toBe(DEFAULT_BUDGET.maxSteps);
    expect(budget.maxCostUsd).toBe(DEFAULT_BUDGET.maxCostUsd);
    expect(budget.maxTotalTokens).toBe(DEFAULT_BUDGET.maxTotalTokens);
  });

  it('produces a budget the checker accepts', () => {
    const budget = clampBudget({ maxSteps: 1 }, DEFAULT_BUDGET);
    expect(checkBudget(budget, emptyConsumption)).toBeUndefined();
    expect(checkBudget(budget, { ...emptyConsumption, steps: 1 })).toBe('max_steps');
  });
});

describe('remaining and cost', () => {
  it('never reports a negative remainder', () => {
    const remaining = budgetRemaining(DEFAULT_BUDGET, {
      ...emptyConsumption, steps: 10_000, costUsd: 99,
    });
    expect(remaining.steps).toBe(0);
    expect(remaining.costUsd).toBe(0);
  });

  it('prices cache reads separately when the card says so', () => {
    const cost = computeCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
      { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
    );
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it('falls back to the input rate for an unpriced cache tier', () => {
    // Guessing zero would understate the bill; guessing the input rate is the
    // conservative direction.
    const cost = computeCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
      { inputPerMTok: 3, outputPerMTok: 15 },
    );
    expect(cost).toBeCloseTo(3, 6);
  });
});
