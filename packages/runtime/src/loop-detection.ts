/**
 * Loop detection.
 *
 * The characteristic agent failure is not a crash. It is a model that calls the
 * same tool with the same arguments, reads the same answer, and calls it again —
 * burning budget, and, when the tool writes, repeating a side effect. Budgets
 * stop this eventually; they stop it expensively and with nothing to tell the
 * user.
 *
 * Detection is exact-match only. A near-miss heuristic would eventually block a
 * legitimate retry with a corrected argument, which is exactly the behaviour we
 * want a model to exhibit.
 */
import { canonicalJson } from '@salvations/core';

export interface ObservedCall {
  readonly canonicalName: string;
  readonly args: unknown;
}

export interface LoopVerdict {
  readonly looping: boolean;
  readonly canonicalName?: string;
  readonly repeats?: number;
  readonly message?: string;
}

const NOT_LOOPING: LoopVerdict = Object.freeze({ looping: false });

export interface LoopDetectorOptions {
  /** Identical calls tolerated before the run is stopped. */
  readonly threshold?: number;
  /** How far back to look. Bounded so a long run does not grow this forever. */
  readonly window?: number;
}

export const DEFAULT_LOOP_THRESHOLD = 3;

/**
 * Counts exact repeats within a sliding window.
 *
 * Rebuilt from persisted steps on resume rather than carried in memory: a run
 * that loops across a slice boundary is still looping, and an in-memory counter
 * would reset exactly when the loop got expensive.
 */
export class LoopDetector {
  readonly #threshold: number;
  readonly #window: number;
  readonly #recent: string[] = [];

  constructor(options: LoopDetectorOptions = {}) {
    this.#threshold = options.threshold ?? DEFAULT_LOOP_THRESHOLD;
    this.#window = options.window ?? 24;
  }

  static from(
    history: readonly ObservedCall[],
    options: LoopDetectorOptions = {},
  ): LoopDetector {
    const detector = new LoopDetector(options);
    for (const call of history) detector.record(call);
    return detector;
  }

  /** Stable across argument key order, so a reserialised identical call counts. */
  static keyOf(call: ObservedCall): string {
    return `${call.canonicalName}(${canonicalJson(call.args ?? null)})`;
  }

  record(call: ObservedCall): void {
    this.#recent.push(LoopDetector.keyOf(call));
    if (this.#recent.length > this.#window) this.#recent.shift();
  }

  /** Would admitting this call make it the Nth identical one? */
  inspect(call: ObservedCall): LoopVerdict {
    const key = LoopDetector.keyOf(call);
    const repeats = this.#recent.filter((k) => k === key).length + 1;
    if (repeats < this.#threshold) return NOT_LOOPING;

    return {
      looping: true,
      canonicalName: call.canonicalName,
      repeats,
      message:
        `This exact call was already made ${repeats - 1} times with the same arguments and ` +
        'returned the same result. Repeating it will not produce a different answer — change ' +
        'the arguments, use a different tool, or answer with what you have.',
    };
  }

  /** Inspects a whole phase, including duplicates WITHIN it: a model can emit
   *  the same call twice in one parallel batch. */
  inspectPhase(calls: readonly ObservedCall[]): LoopVerdict {
    const probe = new LoopDetector({ threshold: this.#threshold, window: this.#window });
    for (const key of this.#recent) probe.#recent.push(key);

    for (const call of calls) {
      const verdict = probe.inspect(call);
      if (verdict.looping) return verdict;
      probe.record(call);
    }
    return NOT_LOOPING;
  }
}

/**
 * The kill switch.
 *
 * Deliberately separate from budgets and from permissions: when an agent is
 * misbehaving in production, an operator needs one thing to turn off, and it
 * must not require editing a policy or waiting for a budget to drain.
 */
export interface KillSwitch {
  /** Checked before every step. Returning a reason stops the run immediately. */
  isStopped(workspaceId: string, agentId: string): Promise<string | undefined>;
}

/** A switch that never fires. The default, so composition must opt IN to a
 *  real one rather than silently omit it. */
export const NEVER_STOPPED: KillSwitch = Object.freeze({
  isStopped: async () => undefined,
});
