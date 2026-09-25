import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, emptyConsumption, type RunBudget } from '@salvations/core';
import { BudgetMeter } from './budget-meter';

const budget = (over: Partial<RunBudget> = {}): RunBudget => ({ ...DEFAULT_BUDGET, ...over });
const usage = (input: number, output: number) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0,
});

describe('admission', () => {
  it('admits a step while every limit has room', () => {
    expect(new BudgetMeter(budget(), emptyConsumption).check()).toEqual({ ok: true });
  });

  it('checks before the step, not after', () => {
    // A budget found exhausted afterwards has already been overspent — and on a
    // tool step it has already caused a side effect.
    const meter = new BudgetMeter(budget({ maxSteps: 1 }), emptyConsumption);
    expect(meter.check().ok).toBe(true);
    meter.recordStep();
    expect(meter.check()).toMatchObject({ ok: false, breach: 'max_steps' });
  });

  it('explains a breach in words a user can read', () => {
    const meter = new BudgetMeter(budget({ maxCostUsd: 0.01 }), {
      ...emptyConsumption, costUsd: 0.02,
    });
    expect(meter.check().message).toMatch(/cost budget for this run was exhausted/);
  });

  it('counts wall clock across slices, not just this one', () => {
    // A run resumed five times has still been running for the whole time.
    let now = 1_000;
    const meter = new BudgetMeter(
      budget({ maxWallClockMs: 10_000 }),
      { ...emptyConsumption, wallClockMs: 9_500 },
      { now: () => now },
    );
    expect(meter.check().ok).toBe(true);
    now += 600;
    expect(meter.check()).toMatchObject({ breach: 'max_wall_clock' });
  });
});

describe('tool phases are weighed whole', () => {
  it('refuses a phase that does not fit, rather than admitting part of it', () => {
    // Admitting three of five parallel calls leaves the model a tool message
    // with holes, which reads as tools that silently failed.
    const meter = new BudgetMeter(budget({ maxToolCalls: 5 }), {
      ...emptyConsumption, toolCalls: 3,
    });
    expect(meter.checkToolPhase(2).ok).toBe(true);
    expect(meter.checkToolPhase(3)).toMatchObject({ ok: false, breach: 'max_tool_calls' });
  });

  it('says how many calls are left', () => {
    const meter = new BudgetMeter(budget({ maxToolCalls: 5 }), {
      ...emptyConsumption, toolCalls: 4,
    });
    expect(meter.checkToolPhase(3).message).toMatch(/needs 3 tool calls but only 1 remain/);
  });

  it('fails a phase for an unrelated breach before counting its calls', () => {
    const meter = new BudgetMeter(budget({ maxSteps: 1 }), { ...emptyConsumption, steps: 1 });
    expect(meter.checkToolPhase(1)).toMatchObject({ breach: 'max_steps' });
  });
});

describe('AC-8 — cost is what was actually spent', () => {
  it('accumulates from real usage rather than an estimate', () => {
    const meter = new BudgetMeter(budget(), emptyConsumption, {
      rates: { inputPerMTok: 3, outputPerMTok: 15 },
    });
    meter.recordUsage(usage(1_000_000, 100_000));

    expect(meter.consumed.tokens).toBe(1_100_000);
    expect(meter.consumed.costUsd).toBeCloseTo(3 + 1.5, 6);
  });

  it('includes the step that breached the budget in the reported cost', () => {
    // Reporting the cost as of before the last call understates the bill by
    // exactly the most expensive step.
    const meter = new BudgetMeter(
      budget({ maxCostUsd: 3, maxTotalTokens: 10_000_000 }), emptyConsumption, {
      rates: { inputPerMTok: 10, outputPerMTok: 10 },
    });
    meter.recordUsage(usage(200_000, 0));
    expect(meter.check().ok).toBe(true);
    meter.recordUsage(usage(0, 200_000));

    expect(meter.check()).toMatchObject({ breach: 'max_cost' });
    expect(meter.consumed.costUsd).toBeCloseTo(4, 6);
  });

  it('still counts tokens when no rate card is configured', () => {
    // An unpriced model must not be an unmetered one.
    const meter = new BudgetMeter(budget(), emptyConsumption);
    meter.recordUsage(usage(100, 50));
    expect(meter.consumed.tokens).toBe(150);
    expect(meter.consumed.costUsd).toBe(0);
  });

  it('separates cache reads from fresh input when priced differently', () => {
    const meter = new BudgetMeter(budget(), emptyConsumption, {
      rates: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
    });
    meter.recordUsage({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0,
    });
    expect(meter.consumed.costUsd).toBeCloseTo(0.3, 6);
  });
});

describe('resumption', () => {
  it('rebuilds from the run’s persisted consumption', () => {
    // Nothing authoritative lives in the meter; a slice that dies loses nothing.
    const meter = new BudgetMeter(budget(), {
      steps: 5, toolCalls: 9, tokens: 1_000, wallClockMs: 2_000, costUsd: 0.4,
    });
    expect(meter.remaining.steps).toBe(DEFAULT_BUDGET.maxSteps - 5);
    expect(meter.remaining.toolCalls).toBe(DEFAULT_BUDGET.maxToolCalls - 9);
    expect(meter.remaining.costUsd).toBeCloseTo(DEFAULT_BUDGET.maxCostUsd - 0.4, 6);
  });
});

describe('derived limits', () => {
  it('never asks for more output tokens than the run can afford', () => {
    const meter = new BudgetMeter(budget({ maxTotalTokens: 1_000 }), {
      ...emptyConsumption, tokens: 900,
    });
    expect(meter.maxOutputTokensFor(4_096)).toBe(100);
  });

  it('never returns a negative allowance', () => {
    const meter = new BudgetMeter(budget({ maxTotalTokens: 100 }), {
      ...emptyConsumption, tokens: 500,
    });
    expect(meter.maxOutputTokensFor(4_096)).toBe(0);
  });

  it('counts MRTR rounds per run, not per call', () => {
    // A server that asks four times across four calls has asked four times.
    const meter = new BudgetMeter(budget({ maxMrtrRounds: 4 }), emptyConsumption);
    meter.recordMrtrRounds(2);
    expect(meter.mrtrRoundsExhausted()).toBe(false);
    meter.recordMrtrRounds(2);
    expect(meter.mrtrRoundsExhausted()).toBe(true);
  });
});
