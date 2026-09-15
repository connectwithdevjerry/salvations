/**
 * One tool phase.
 *
 * The model emitted some number of `tool_use` blocks; this executes them and
 * produces exactly ONE tool message carrying a `tool_result` for every one of
 * them, in the same order.
 *
 * "Every one of them" is not stylistic. A provider that receives a tool message
 * missing a result for a `tool_use` it emitted either rejects the request or
 * reads it as a tool that failed silently, and the model then apologises for
 * something that never happened.
 *
 * The other rule: a tool call is never executed twice. A phase can suspend
 * half-done — one call needs approval while three have already written to a
 * calendar — so completed results are passed back in on resume rather than
 * re-invoked.
 */
import {
  toolResultBlock,
  type ContentBlock, type McpBindingId, type RunContext, type ToolGateway,
  type ToolOutcome,
} from '@salvations/core';
import { LoopDetector, type LoopVerdict, type ObservedCall } from './loop-detection';
import type { PublishEvent } from './model-call';

export interface RequestedCall {
  readonly id: string;
  readonly canonicalName: string;
  readonly input: unknown;
}

export interface CompletedCall {
  readonly id: string;
  readonly canonicalName: string;
  readonly content: readonly ContentBlock[];
  readonly structured?: unknown;
  readonly isError: boolean;
  readonly bindingId?: McpBindingId;
  readonly durationMs: number;
  readonly mrtrRounds: number;
}

export type PhaseOutcome =
  /** Every call resolved. The tool message is ready to append. */
  | { readonly kind: 'complete'; readonly completed: readonly CompletedCall[];
      readonly message: readonly ContentBlock[] }
  /**
   * A call needs a person. The run suspends.
   *
   * `completed` carries everything that already ran, so resumption replays it
   * instead of repeating the side effects.
   */
  | { readonly kind: 'suspended'; readonly reason: 'approval' | 'input' | 'tool';
      readonly approvalId?: string; readonly requestState?: string;
      readonly pendingCallId: string; readonly completed: readonly CompletedCall[] }
  /** A loop was detected. Nothing was executed. */
  | { readonly kind: 'refused'; readonly verdict: LoopVerdict;
      readonly message: readonly ContentBlock[] };

export interface ToolPhaseOptions {
  readonly gateway: ToolGateway;
  readonly detector?: LoopDetector;
  readonly publish?: PublishEvent;
  readonly now?: () => number;
  /** Cap on how many calls run at once, independent of what the model asked for. */
  readonly maxParallel?: number;
}

const DEFAULT_MAX_PARALLEL = 6;

export class ToolPhaseRunner {
  readonly #gateway: ToolGateway;
  readonly #detector: LoopDetector;
  readonly #publish: PublishEvent | undefined;
  readonly #now: () => number;
  readonly #maxParallel: number;

  constructor(options: ToolPhaseOptions) {
    this.#gateway = options.gateway;
    this.#detector = options.detector ?? new LoopDetector();
    this.#publish = options.publish;
    this.#now = options.now ?? (() => Date.now());
    this.#maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL;
  }

  /**
   * Runs a phase.
   *
   * `alreadyCompleted` is keyed by tool-use id and comes from the run's
   * persisted steps.
   */
  async run(
    calls: readonly RequestedCall[],
    ctx: RunContext,
    alreadyCompleted: ReadonlyMap<string, CompletedCall> = new Map(),
  ): Promise<PhaseOutcome> {
    const outstanding = calls.filter((c) => !alreadyCompleted.has(c.id));

    const observed: ObservedCall[] = outstanding.map((c) =>
      ({ canonicalName: c.canonicalName, args: c.input }));
    const verdict = this.#detector.inspectPhase(observed);
    if (verdict.looping) {
      // Refused as a tool RESULT for every call, so the model reads why rather
      // than seeing its calls vanish.
      return {
        kind: 'refused',
        verdict,
        message: calls.map((c) =>
          toolResultBlock(c.id, [{ type: 'text', text: verdict.message as string }],
            { isError: true })),
      };
    }

    const completed = new Map(alreadyCompleted);
    // Parallel only where the model supports it AND the call order does not
    // encode a dependency the model expressed by asking for one at a time.
    const concurrency = ctx.capabilities.tools.parallelCalls ? this.#maxParallel : 1;

    for (let i = 0; i < outstanding.length; i += concurrency) {
      const batch = outstanding.slice(i, i + concurrency);
      const outcomes = await Promise.all(
        batch.map(async (call) => ({ call, outcome: await this.#invoke(call, ctx) })),
      );

      for (const { call, outcome } of outcomes) {
        if (outcome.kind === 'result') {
          const done: CompletedCall = {
            id: call.id,
            canonicalName: call.canonicalName,
            content: outcome.content,
            ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}),
            isError: outcome.isError,
            bindingId: outcome.bindingId,
            durationMs: outcome.durationMs,
            mrtrRounds: outcome.mrtrRounds,
          };
          completed.set(call.id, done);
          this.#detector.record({ canonicalName: call.canonicalName, args: call.input });
          await this.#publish?.('tool_call_finished', {
            id: call.id, name: call.canonicalName, isError: done.isError,
            durationMs: done.durationMs,
          });
          continue;
        }

        // A suspension ends the phase. Calls already finished in this batch are
        // kept; calls not yet started are simply not started.
        return {
          kind: 'suspended',
          reason: outcome.kind === 'needs_approval' ? 'approval'
            : outcome.kind === 'needs_input' ? 'input' : 'tool',
          ...(outcome.kind === 'needs_approval' || outcome.kind === 'needs_input'
            ? { approvalId: outcome.approvalId }
            : {}),
          ...(outcome.kind === 'needs_input' ? { requestState: outcome.requestState } : {}),
          pendingCallId: call.id,
          completed: orderedResults(calls, completed),
        };
      }
    }

    const ordered = orderedResults(calls, completed);
    return {
      kind: 'complete',
      completed: ordered,
      // Order matters: several providers match results to calls positionally
      // as well as by id.
      message: ordered.map((done) =>
        toolResultBlock(done.id, done.content, {
          ...(done.structured !== undefined ? { structured: done.structured } : {}),
          isError: done.isError,
        })),
    };
  }

  async #invoke(call: RequestedCall, ctx: RunContext): Promise<ToolOutcome> {
    const started = this.#now();
    await this.#publish?.('tool_call_started', { id: call.id, name: call.canonicalName });

    try {
      return await this.#gateway.invoke(call.canonicalName, call.input, ctx);
    } catch (error) {
      // The gateway returns refusals as results; a THROW here is an
      // infrastructure fault. It still has to reach the model as a result, or
      // the tool message would be missing an entry.
      return {
        kind: 'result',
        content: [{
          type: 'text',
          text: `The tool could not be run: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
        bindingId: '' as McpBindingId,
        durationMs: this.#now() - started,
        mrtrRounds: 0,
      };
    }
  }
}

/** Results in the order the model asked, which is not the order they finished. */
function orderedResults(
  calls: readonly RequestedCall[],
  completed: ReadonlyMap<string, CompletedCall>,
): readonly CompletedCall[] {
  const ordered: CompletedCall[] = [];
  for (const call of calls) {
    const done = completed.get(call.id);
    if (done !== undefined) ordered.push(done);
  }
  return ordered;
}
