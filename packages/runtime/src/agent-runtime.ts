/**
 * The agent runtime: one step.
 *
 * `stepOnce` does exactly ONE of: a compaction, a model call, or a tool phase.
 * It never loops. An EXECUTOR owns the loop, and that inversion is the whole
 * migration strategy — a serverless slice and a long-lived worker differ only
 * in how long they are willing to keep calling this.
 *
 * Everything a step learns is persisted before it returns. The process holds no
 * authoritative state, so a run survives a crash, a deploy, or a slice boundary
 * without special handling for any of them.
 */
import {
  messageText, toolUseBlocks,
  type Message, type RunContext, type SystemDirective, type ToolGateway,
} from '@salvations/core';
import { BudgetMeter, type ModelRates } from './budget-meter';
import { assemblePrompt, estimateTokens } from './context-assembler';
import { selectCapabilities } from './capability-selector';
import { compact, fallbackSummary, planCompaction, type CompactionPolicy } from './compaction';
import { LoopDetector, NEVER_STOPPED, type KillSwitch } from './loop-detection';
import { ModelCallError, ModelCaller, type ModelAttempt, type PublishEvent } from './model-call';
import { ToolPhaseRunner, type CompletedCall, type RequestedCall } from './tool-phase';
import type { RunStateStore, SummariseMessages } from './state';

export type StopReason = 'budget' | 'loop' | 'kill_switch' | 'model_error' | 'compaction_stuck';

export type StepOutcome =
  /** Progress was made and there is more to do. */
  | { readonly kind: 'continue'; readonly did: 'model_call' | 'tool_phase' | 'compaction' }
  /** The model finished its turn. */
  | { readonly kind: 'finished'; readonly text: string }
  /** A person is needed. No process, socket or memory is held while waiting. */
  | { readonly kind: 'suspended'; readonly reason: 'approval' | 'input' | 'tool';
      readonly approvalId?: string }
  /**
   * The run stopped short. `text` is whatever the agent had produced, so the
   * user gets a partial answer and an explanation rather than an error page.
   */
  | { readonly kind: 'stopped'; readonly reason: StopReason; readonly message: string;
      readonly text: string };

/** Everything resolved once per run, per model. */
export interface ResolvedRun {
  readonly ctx: RunContext;
  /** Primary first, fallback after. Each carries its own assembled request. */
  readonly attemptsFor: (
    request: ModelAttempt['request'],
  ) => readonly Omit<ModelAttempt, 'request'>[];
  readonly rates?: ModelRates;
  /** Alias → binding id, for the capabilities this agent can see. */
  readonly bindingIdByAlias: ReadonlyMap<string, string>;
  readonly systemDirectives: readonly SystemDirective[];
  readonly maxOutputTokens: number;
}

export interface AgentRuntimeDeps {
  readonly store: RunStateStore;
  readonly gateway: ToolGateway;
  readonly summarise?: SummariseMessages;
  readonly killSwitch?: KillSwitch;
  readonly publish?: PublishEvent;
  readonly caller?: ModelCaller;
  readonly detector?: LoopDetector;
  readonly compaction?: CompactionPolicy;
  readonly now?: () => number;
}

export class AgentRuntime {
  readonly #deps: AgentRuntimeDeps;
  readonly #caller: ModelCaller;
  readonly #detector: LoopDetector;
  readonly #killSwitch: KillSwitch;
  readonly #now: () => number;

  constructor(deps: AgentRuntimeDeps) {
    this.#deps = deps;
    this.#caller = deps.caller ?? new ModelCaller(
      deps.publish !== undefined ? { publish: deps.publish } : {},
    );
    this.#detector = deps.detector ?? new LoopDetector();
    this.#killSwitch = deps.killSwitch ?? NEVER_STOPPED;
    this.#now = deps.now ?? (() => Date.now());
  }

  async stepOnce(resolved: ResolvedRun, signal: AbortSignal): Promise<StepOutcome> {
    const { ctx } = resolved;
    const meter = new BudgetMeter(ctx.budget, ctx.consumed, {
      now: this.#now,
      ...(resolved.rates !== undefined ? { rates: resolved.rates } : {}),
    });

    const messages = await this.#deps.store.loadMessages();

    // 1. The kill switch, first and unconditionally. When an agent is
    //    misbehaving in production an operator needs one thing to turn off, and
    //    it must not wait for a budget to drain or a policy to be edited.
    const stopped = await this.#killSwitch.isStopped(
      String(ctx.workspaceId), String(ctx.agentId),
    );
    if (stopped !== undefined) {
      return this.#stop('kill_switch', stopped, messages, meter);
    }

    // 2. Budget, before anything is spent or any side effect occurs.
    const verdict = meter.check();
    if (!verdict.ok) {
      return this.#stop('budget', verdict.message as string, messages, meter);
    }

    // 3. A phase already in flight takes precedence: the model asked for tools
    //    and is owed their results before it can say anything else.
    const pending = pendingToolCalls(messages);
    if (pending !== undefined) {
      return this.#toolPhase(resolved, meter, pending, messages);
    }

    // 4. Compaction is its own step. Doing it inline would make one step both
    //    two model calls and unresumable halfway.
    const plan = planCompaction(messages, ctx.capabilities, this.#deps.compaction);
    if (plan.needed) {
      return this.#compact(meter, plan, signal);
    }

    return this.#modelCall(resolved, meter, messages, signal);
  }

  async #modelCall(
    resolved: ResolvedRun,
    meter: BudgetMeter,
    messages: readonly Message[],
    signal: AbortSignal,
  ): Promise<StepOutcome> {
    const { ctx } = resolved;
    const started = this.#now();

    const available = await this.#deps.gateway.listAvailable(ctx);
    const selection = selectCapabilities({
      available,
      snapshot: ctx.agentSnapshot,
      capabilities: ctx.capabilities,
      bindingIdByAlias: resolved.bindingIdByAlias,
    });

    const prompt = assemblePrompt({
      ctx,
      directives: resolved.systemDirectives,
      messages,
      tools: selection.tools,
      maxOutputTokens: meter.maxOutputTokensFor(resolved.maxOutputTokens),
    });

    const attempts: ModelAttempt[] = resolved
      .attemptsFor(prompt.request)
      .map((attempt) => ({ ...attempt, request: prompt.request }));

    meter.recordStep();
    await this.#deps.publish?.('step_started', {
      seq: ctx.stepSeq, type: 'model_call', prefixFingerprint: prompt.prefixFingerprint,
    });

    let result;
    try {
      result = await this.#caller.call(attempts, signal);
    } catch (error) {
      const message = error instanceof ModelCallError
        ? error.providerError.message
        : error instanceof Error ? error.message : String(error);

      await this.#deps.store.recordStep({
        type: 'model_call',
        status: 'failed',
        latencyMs: this.#now() - started,
        error: { code: 'model_call_failed', message },
      });
      await this.#deps.store.saveConsumption(meter.consumed, meter.usage);
      return this.#stop('model_error', message, messages, meter);
    }

    meter.recordUsage(result.usage);

    const appended = await this.#deps.store.appendMessage({
      role: 'assistant',
      content: result.content,
      ...(result.providerArtifacts !== undefined
        // Keyed by the model that produced it, so a later model drops it rather
        // than replaying state it cannot read.
        ? { providerArtifacts: { [ctx.providerKey]: result.providerArtifacts } }
        : {}),
      tokenEstimate: estimateTokens(result.content),
    });

    await this.#deps.store.recordStep({
      type: 'model_call',
      status: 'succeeded',
      response: { finishReason: result.finishReason, messageId: appended.id },
      usage: result.usage,
      latencyMs: result.latencyMs,
    });
    await this.#deps.store.saveConsumption(meter.consumed, meter.usage);

    if (toolUseBlocks(result.content).length > 0) {
      return { kind: 'continue', did: 'model_call' };
    }

    await this.#deps.publish?.('run_finished', { finishReason: result.finishReason });
    return { kind: 'finished', text: messageText(result.content) };
  }

  async #toolPhase(
    resolved: ResolvedRun,
    meter: BudgetMeter,
    calls: readonly RequestedCall[],
    messages: readonly Message[],
  ): Promise<StepOutcome> {
    const { ctx } = resolved;
    const started = this.#now();

    const persisted = await this.#deps.store.completedToolCalls();
    const outstanding = calls.filter((c) => !persisted.has(c.id));

    // Weighed whole: a partially admitted phase leaves the model a tool message
    // with holes, which reads as tools that silently failed.
    const verdict = meter.checkToolPhase(outstanding.length);
    if (!verdict.ok) {
      return this.#stop('budget', verdict.message as string, messages, meter);
    }

    const runner = new ToolPhaseRunner({
      gateway: this.#deps.gateway,
      detector: this.#detector,
      now: this.#now,
      ...(this.#deps.publish !== undefined ? { publish: this.#deps.publish } : {}),
    });

    const already = new Map<string, CompletedCall>();
    for (const [id, result] of persisted) already.set(id, result as CompletedCall);

    const outcome = await runner.run(calls, ctx, already);

    if (outcome.kind === 'refused') {
      // The loop is answered IN the conversation, so the model reads why and
      // can choose differently, rather than the run dying silently.
      await this.#deps.store.appendMessage({ role: 'tool', content: outcome.message });
      await this.#deps.store.recordStep({
        type: 'tool_call',
        status: 'failed',
        latencyMs: this.#now() - started,
        error: { code: 'loop_detected', message: outcome.verdict.message as string },
      });
      return this.#stop('loop', outcome.verdict.message as string, messages, meter);
    }

    // Every result is durable before the phase can suspend, so nothing is
    // executed twice on resume.
    for (const done of outcome.completed) {
      if (!persisted.has(done.id)) {
        await this.#deps.store.saveToolResult(done);
        meter.recordToolCalls(1);
        meter.recordMrtrRounds(done.mrtrRounds);
      }
    }
    await this.#deps.store.saveConsumption(meter.consumed, meter.usage);

    if (outcome.kind === 'suspended') {
      await this.#deps.publish?.('run_suspended', {
        reason: outcome.reason, approvalId: outcome.approvalId,
      });
      return {
        kind: 'suspended',
        reason: outcome.reason,
        ...(outcome.approvalId !== undefined ? { approvalId: outcome.approvalId } : {}),
      };
    }

    await this.#deps.store.appendMessage({ role: 'tool', content: outcome.message });
    await this.#deps.store.recordStep({
      type: 'tool_call',
      status: 'succeeded',
      latencyMs: this.#now() - started,
    });

    return { kind: 'continue', did: 'tool_phase' };
  }

  async #compact(
    meter: BudgetMeter,
    plan: ReturnType<typeof planCompaction>,
    signal: AbortSignal,
  ): Promise<StepOutcome> {
    const started = this.#now();
    const summarise = this.#deps.summarise;

    // A summariser that is down must not take the run with it: a rough summary
    // loses detail, and no summary loses the conversation.
    const summariseOrFallback: SummariseMessages = async (messages, sig) => {
      if (summarise === undefined) return fallbackSummary(plan.toSummarise);
      try {
        return await summarise(messages, sig);
      } catch {
        return fallbackSummary(plan.toSummarise);
      }
    };

    const result = await compact(plan, summariseOrFallback, signal);

    const appended = await this.#deps.store.appendMessage({
      role: 'system',
      content: result.summary,
      tokenEstimate: estimateTokens(result.summary),
    });
    // Appended first, then superseded: a crash between the two leaves a
    // harmless duplicate summary rather than a conversation with a hole.
    await this.#deps.store.supersede(result.supersededIds, appended.id);

    meter.recordStep();
    await this.#deps.store.recordStep({
      type: 'compaction',
      status: 'succeeded',
      response: {
        replaced: result.supersededIds.length,
        tokensBefore: result.estimatedTokensBefore,
        tokensAfter: result.estimatedTokensAfter,
      },
      latencyMs: this.#now() - started,
    });
    await this.#deps.store.saveConsumption(meter.consumed, meter.usage);

    return { kind: 'continue', did: 'compaction' };
  }

  /**
   * Stops the run with whatever the agent had produced.
   *
   * AC-8: a user whose budget ran out gets the partial answer and the reason,
   * not an error page. The work was paid for either way.
   */
  async #stop(
    reason: StopReason,
    message: string,
    messages: readonly Message[],
    meter: BudgetMeter,
  ): Promise<StepOutcome> {
    await this.#deps.store.saveConsumption(meter.consumed, meter.usage);
    await this.#deps.publish?.('run_finished', { reason, message });
    return { kind: 'stopped', reason, message, text: lastAssistantText(messages) };
  }
}

/**
 * Tool calls the model asked for and has not been answered.
 *
 * Read from the conversation rather than a side record: the conversation IS the
 * state, and a second source of truth is a second thing to get out of step.
 */
export function pendingToolCalls(
  messages: readonly Message[],
): readonly RequestedCall[] | undefined {
  const live = messages.filter((m) => m.supersededBy === undefined);
  const last = live.at(-1);
  if (last === undefined || last.role !== 'assistant') return undefined;

  const requested = toolUseBlocks(last.content);
  if (requested.length === 0) return undefined;

  return requested.map((block) => ({
    id: block.id,
    canonicalName: block.name,
    input: block.input,
  }));
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Message;
    if (message.role !== 'assistant' || message.supersededBy !== undefined) continue;
    const text = messageText(message.content);
    if (text.trim() !== '') return text;
  }
  return '';
}
