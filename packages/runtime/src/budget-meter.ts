/**
 * Budget accounting for one run.
 *
 * Budgets are enforced HERE, not by a vendor feature. A budget that only exists
 * inside one provider's dashboard is not a budget: it does not cover the second
 * provider, it does not cover tool calls, and it cannot stop a run.
 *
 * The meter is the mutable half of `checkBudget`, which stays pure in the
 * domain. It survives a slice boundary because it is rebuilt from the run's
 * persisted `consumed` — nothing authoritative lives in this object.
 */
import {
  addUsage, budgetRemaining, checkBudget, computeCostUsd, emptyUsage,
  type BudgetBreach, type RunBudget, type RunConsumption, type Usage,
} from '@salvations/core';

export interface ModelRates {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
  readonly cacheWritePerMTok?: number;
}

export interface BudgetMeterOptions {
  /** Wall clock is measured across every slice, so it comes from the run. */
  readonly now?: () => number;
  readonly rates?: ModelRates;
}

/** Why a step may not start. */
export interface BudgetVerdict {
  readonly ok: boolean;
  readonly breach?: BudgetBreach;
  readonly message?: string;
}

const OK: BudgetVerdict = Object.freeze({ ok: true });

const EXPLANATIONS: Readonly<Record<BudgetBreach, string>> = Object.freeze({
  max_steps: 'the step limit for this run was reached',
  max_tool_calls: 'the tool-call limit for this run was reached',
  max_tokens: 'the token budget for this run was exhausted',
  max_wall_clock: 'this run ran for longer than its time budget allows',
  max_cost: 'the cost budget for this run was exhausted',
});

export class BudgetMeter {
  readonly #budget: RunBudget;
  readonly #now: () => number;
  readonly #rates: ModelRates | undefined;
  readonly #sliceStartedAt: number;
  readonly #priorWallClockMs: number;

  #steps: number;
  #toolCalls: number;
  #tokens: number;
  #costUsd: number;
  #mrtrRounds = 0;
  #usage: Usage = emptyUsage;

  constructor(
    budget: RunBudget,
    consumed: RunConsumption,
    options: BudgetMeterOptions = {},
  ) {
    this.#budget = budget;
    this.#now = options.now ?? (() => Date.now());
    this.#rates = options.rates;
    this.#steps = consumed.steps;
    this.#toolCalls = consumed.toolCalls;
    this.#tokens = consumed.tokens;
    this.#costUsd = consumed.costUsd;
    this.#priorWallClockMs = consumed.wallClockMs;
    this.#sliceStartedAt = this.#now();
  }

  /** Everything spent so far, including the time this slice has been running. */
  get consumed(): RunConsumption {
    return {
      steps: this.#steps,
      toolCalls: this.#toolCalls,
      tokens: this.#tokens,
      costUsd: this.#costUsd,
      wallClockMs: this.#priorWallClockMs + (this.#now() - this.#sliceStartedAt),
    };
  }

  get usage(): Usage { return this.#usage; }
  get mrtrRounds(): number { return this.#mrtrRounds; }
  get remaining(): ReturnType<typeof budgetRemaining> {
    return budgetRemaining(this.#budget, this.consumed);
  }

  /**
   * May another step start?
   *
   * Checked BEFORE the step, never after. A budget discovered to be exhausted
   * after the fact has already been overspent, and on a tool step it has already
   * caused a side effect.
   */
  check(): BudgetVerdict {
    const breach = checkBudget(this.#budget, this.consumed);
    if (breach === undefined) return OK;
    return { ok: false, breach, message: EXPLANATIONS[breach] };
  }

  /**
   * May a tool phase of this size start?
   *
   * The whole phase is weighed at once: admitting three of five parallel calls
   * would leave the model a tool message with holes in it, which reads to the
   * model as tools that silently failed.
   */
  checkToolPhase(callCount: number): BudgetVerdict {
    const first = this.check();
    if (!first.ok) return first;
    if (this.#toolCalls + callCount > this.#budget.maxToolCalls) {
      return {
        ok: false,
        breach: 'max_tool_calls',
        message:
          `this turn needs ${callCount} tool calls but only ` +
          `${Math.max(0, this.#budget.maxToolCalls - this.#toolCalls)} remain in the run's budget`,
      };
    }
    return OK;
  }

  recordStep(): void { this.#steps += 1; }

  recordToolCalls(count: number): void { this.#toolCalls += count; }

  recordMrtrRounds(rounds: number): void { this.#mrtrRounds += rounds; }

  /** Rounds are counted per RUN, not per call: a server that asks four times
   *  across four calls has asked four times. */
  mrtrRoundsExhausted(): boolean {
    return this.#mrtrRounds >= this.#budget.maxMrtrRounds;
  }

  /**
   * Records what a model call actually cost.
   *
   * Cost is computed from real usage rather than estimated up front, so the
   * figure reported when a budget stops a run is the figure that was spent
   * (AC-8) — including the step that breached it.
   */
  recordUsage(usage: Usage): void {
    this.#usage = addUsage(this.#usage, usage);
    this.#tokens += usage.inputTokens + usage.outputTokens;
    if (this.#rates !== undefined) {
      this.#costUsd += computeCostUsd(usage, this.#rates);
    }
  }

  /** How many output tokens this step may ask for, given what is left. */
  maxOutputTokensFor(requested: number): number {
    const remaining = this.remaining.tokens;
    return Math.max(0, Math.min(requested, remaining));
  }
}
