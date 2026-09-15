/**
 * Run: the unit of agent execution.
 *
 * A run is a persisted, resumable state machine. Every step is written before
 * the next begins, so the executing process holds no authoritative state and a
 * run survives a crash, a deploy, or a serverless slice boundary.
 */
import type {
  AgentId, AgentVersionId, ApprovalId, ConversationId, LeaseToken,
  McpBindingId, ModelBindingId, RunId, RunStepId, UserId, WorkspaceId,
} from '../ids';
import type { ProviderKey } from './conversation';
import type { Usage } from './model';
import type { Principal } from './principal';

export type RunStatus =
  | 'queued'
  | 'running'
  /** Suspended states hold no process, no socket, no memory. */
  | 'waiting_approval'
  | 'waiting_input'
  | 'waiting_tool'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'succeeded', 'failed', 'cancelled', 'expired',
];
export const SUSPENDED_STATUSES: readonly RunStatus[] = [
  'waiting_approval', 'waiting_input', 'waiting_tool',
];

export const isTerminal = (s: RunStatus): boolean => TERMINAL_STATUSES.includes(s);
export const isSuspended = (s: RunStatus): boolean => SUSPENDED_STATUSES.includes(s);

export type TriggerType = 'user' | 'api' | 'channel' | 'schedule' | 'agent';

/**
 * Budgets are enforced by the runtime, independent of any vendor-side budgeting
 * feature. That independence is the point: a budget that only exists inside one
 * vendor's API is not a budget.
 */
export interface RunBudget {
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
  readonly maxWallClockMs: number;
  readonly maxCostUsd: number;
  readonly maxMrtrRounds: number;
  readonly maxSubagentDepth: number;
}

export const DEFAULT_BUDGET: RunBudget = Object.freeze({
  maxSteps: 24,
  maxToolCalls: 48,
  maxTotalTokens: 400_000,
  maxWallClockMs: 900_000,
  maxCostUsd: 2,
  maxMrtrRounds: 4,
  maxSubagentDepth: 2,
});

export interface RunConsumption {
  readonly steps: number;
  readonly toolCalls: number;
  readonly tokens: number;
  readonly wallClockMs: number;
  readonly costUsd: number;
}

export const emptyConsumption: RunConsumption = Object.freeze({
  steps: 0, toolCalls: 0, tokens: 0, wallClockMs: 0, costUsd: 0,
});

/** Immutable configuration snapshot, so a run stays reproducible if the agent is edited. */
export interface AgentSnapshot {
  readonly systemPrompt: string;
  readonly modelRole: ModelRole;
  readonly capabilityBindings: readonly AgentCapabilityBinding[];
  readonly guardrails: { readonly maxToolCallsPerTurn: number };
}

export type ModelRole = 'chat' | 'reasoning' | 'summarizer' | 'cheap' | 'embedding';

export interface AgentCapabilityBinding {
  readonly bindingId: McpBindingId;
  readonly mode: 'all' | 'allow' | 'deny';
  readonly tools: readonly string[];
}

/** Lease record making `runs` itself the work queue. */
export interface RunLease {
  readonly owner: string;
  readonly until: Date;
  readonly token: LeaseToken;
}

export interface Run {
  readonly id: RunId;
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;

  readonly agentId: AgentId;
  readonly agentVersionId: AgentVersionId;
  readonly agentSnapshot: AgentSnapshot;
  readonly modelBindingId: ModelBindingId;
  readonly providerKey?: ProviderKey;

  readonly trigger: { readonly type: TriggerType; readonly ref?: string };
  /** Snapshotted at creation and re-validated on resume, so revocation fails closed. */
  readonly principal: Principal;

  readonly status: RunStatus;
  readonly priority: number;
  readonly scheduledFor: Date;
  readonly lease?: RunLease;
  readonly attempts: number;
  readonly continuation?: { readonly fromStep: number; readonly reason: 'deadline' | 'retry' };

  readonly budget: RunBudget;
  readonly consumed: RunConsumption;
  readonly usage: Usage;

  readonly nextStepSeq: number;
  readonly parentRunId?: RunId;
  readonly depth: number;
  readonly idempotencyKey?: string;

  readonly error?: { readonly code: string; readonly message: string };
  readonly queuedAt: Date;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  readonly heartbeatAt?: Date;
}

export type RunStepType =
  | 'model_call'
  | 'tool_call'
  | 'compaction'
  | 'input_required'
  | 'memory_write'
  | 'subagent';

export type PermissionEffect = 'allow' | 'ask' | 'deny';

export interface ToolInvocation {
  readonly id: string;
  readonly bindingId: McpBindingId;
  readonly capabilityName: string;
  /** Redacted at WRITE time, not at display time. */
  readonly argumentsRedacted: unknown;
  readonly permissionDecision: {
    readonly effect: PermissionEffect;
    readonly matchedRuleId?: string;
    readonly reason?: string;
    readonly approvalId?: ApprovalId;
  };
  readonly resultRef?: { readonly blobKey: string; readonly bytes: number };
  readonly isError: boolean;
  readonly mrtrRounds: number;
  readonly mcpTaskId?: string;
  readonly durationMs: number;
}

export interface RunStep {
  readonly id: RunStepId;
  readonly runId: RunId;
  readonly workspaceId: WorkspaceId;
  readonly seq: number;
  readonly type: RunStepType;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly request?: unknown;
  readonly response?: unknown;
  readonly toolCalls?: readonly ToolInvocation[];
  readonly usage?: Usage;
  readonly latencyMs?: number;
  readonly error?: { readonly code: string; readonly message: string };
  readonly startedAt: Date;
  readonly finishedAt?: Date;
}

export type RunEventType =
  | 'run_started'
  | 'step_started'
  | 'text_delta'
  | 'reasoning_delta'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'approval_requested'
  | 'run_suspended'
  | 'run_yielded'
  | 'run_finished'
  | 'error';

export interface RunEvent {
  readonly runId: RunId;
  readonly workspaceId: WorkspaceId;
  readonly seq: number;
  readonly type: RunEventType;
  readonly payload: unknown;
  readonly createdAt: Date;
}

export type ApprovalKind = 'tool_call' | 'mrtr_input' | 'budget_increase';

export interface Approval {
  readonly id: ApprovalId;
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly runStepSeq: number;
  readonly kind: ApprovalKind;
  readonly payload: unknown;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  readonly decision?: 'approve' | 'deny';
  readonly decidedBy?: UserId;
  readonly decidedAt?: Date;
  readonly response?: unknown;
}
