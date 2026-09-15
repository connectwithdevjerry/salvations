/**
 * @salvations/runtime — the agent runtime.
 *
 * Depends on `@salvations/core` ports only. It never imports a provider
 * adapter, the MCP client, the database, or a deployment platform: those are
 * bound at the composition root, which is what lets the identical `stepOnce`
 * run inside a serverless slice and inside a long-lived worker.
 */
export {
  AgentRuntime, pendingToolCalls,
  type AgentRuntimeDeps, type ResolvedRun, type StepOutcome, type StopReason,
} from './agent-runtime';

export {
  Resolver, ModelUnavailableError, PrincipalRevokedError, keyOf,
  type ModelBinding, type ResolverDeps,
} from './resolver';

export {
  BudgetMeter, type BudgetMeterOptions, type BudgetVerdict, type ModelRates,
} from './budget-meter';

export {
  CACHE_ANCHOR_STRIDE, assemblePrompt, cachedPrefixOf, estimateTokens, prefixFingerprintOf,
  prefixIsPreserved, type AssembleInput, type AssembledPrompt,
} from './context-assembler';

export { selectCapabilities, type Selection, type SelectionInput } from './capability-selector';

export {
  DEFAULT_COMPACTION_TARGET, DEFAULT_COMPACTION_THRESHOLD, DEFAULT_KEEP_RECENT,
  compact, fallbackSummary, planCompaction,
  type CompactionPlan, type CompactionPolicy, type CompactionResult, type Summariser,
} from './compaction';

export {
  DEFAULT_LOOP_THRESHOLD, LoopDetector, NEVER_STOPPED,
  type KillSwitch, type LoopDetectorOptions, type LoopVerdict, type ObservedCall,
} from './loop-detection';

export {
  ModelCallError, ModelCaller, backoffMs,
  type ModelAttempt, type ModelCallOptions, type ModelCallResult, type PublishEvent,
} from './model-call';

export {
  ToolPhaseRunner,
  type CompletedCall, type PhaseOutcome, type RequestedCall, type ToolPhaseOptions,
} from './tool-phase';

export type {
  AppendMessage, RecordedStep, RunStateStore, SummariseMessages, ToolInvocationResult,
} from './state';
