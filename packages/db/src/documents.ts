/**
 * BSON document shapes.
 *
 * These are the storage representation, kept deliberately separate from the
 * domain types in @salvations/core. Mappers translate between them, so a
 * storage change never ripples into the domain and `_id` never leaks upward.
 */
import type { Document } from 'mongodb';
import type { TenantDocument } from './scoped.js';

export interface BaseDoc extends Document {
  _id: string;
}

export interface TenantDoc extends BaseDoc, TenantDocument {
  workspaceId: string;
}

export interface WorkspaceMemberSub {
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  status: 'active' | 'suspended';
  joinedAt: Date;
  invitedBy?: string | null;
}

export interface WorkspaceInvitationSub {
  id: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
}

/**
 * Members are embedded rather than joined: authorization is the hottest path,
 * and this makes "who is this user here, and what role" a single read.
 * Bounded at 500 — see docs/DATA-MODEL.md §2.2.
 */
export interface WorkspaceDoc extends TenantDoc {
  slug: string;
  name: string;
  plan: string;
  settings: {
    defaultToolEffect: 'allow' | 'ask' | 'deny';
    maxConcurrentRuns: number;
    dailyCostCapUsd: number;
    allowedMcpTrustTiers: string[];
  };
  members: WorkspaceMemberSub[];
  invitations: WorkspaceInvitationSub[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface AgentDoc extends TenantDoc {
  slug: string;
  name: string;
  description?: string;
  currentVersion: {
    versionId: string;
    version: number;
    systemPrompt: string;
    modelRole: string;
    capabilityBindings: { bindingId: string; mode: 'all' | 'allow' | 'deny'; tools: string[] }[];
    guardrails: { maxToolCallsPerTurn: number };
  };
  isArchived: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationDoc extends TenantDoc {
  agentId: string;
  channelId?: string | null;
  externalRef?: string | null;
  title?: string | null;
  status: 'active' | 'archived';
  messageCount: number;
  nextSeq: number;
  lastMessage?: { role: string; preview: string; at: Date } | null;
  compaction?: { upToSeq: number; summaryMessageId: string } | null;
  modelBindingId: string;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageDoc extends TenantDoc {
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: unknown[];
  /** Keyed by `provider:model`. Opaque — never parsed, never rendered. */
  providerArtifacts?: Record<string, unknown> | null;
  runId?: string | null;
  tokenEstimate?: number | null;
  createdAt: Date;
  supersededBy?: string | null;
}

export interface RunLeaseSub {
  owner: string;
  until: Date;
  token: string;
}

/**
 * The runs document is simultaneously the run's state, its budget ledger, its
 * lease record, and its queue entry. See docs/DATA-MODEL.md §3.3.
 */
export interface RunDoc extends TenantDoc {
  conversationId: string;
  agentId: string;
  agentVersionId: string;
  agentSnapshot: {
    systemPrompt: string;
    modelRole: string;
    capabilityBindings: { bindingId: string; mode: string; tools: string[] }[];
    guardrails: { maxToolCallsPerTurn: number };
  };
  modelBindingId: string;
  providerKey?: string | null;

  trigger: { type: string; ref?: string | null };
  principal: unknown;

  status: string;
  priority: number;
  scheduledFor: Date;
  lease?: RunLeaseSub | null;
  attempts: number;
  continuation?: { fromStep: number; reason: string } | null;

  budget: {
    maxSteps: number;
    maxToolCalls: number;
    maxTotalTokens: number;
    maxWallClockMs: number;
    maxCostUsd: number;
    maxMrtrRounds: number;
    maxSubagentDepth: number;
  };
  consumed: {
    steps: number;
    toolCalls: number;
    tokens: number;
    wallClockMs: number;
    costUsd: number;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };

  nextStepSeq: number;
  parentRunId?: string | null;
  depth: number;
  idempotencyKey?: string | null;

  error?: { code: string; message: string } | null;
  queuedAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  heartbeatAt?: Date | null;
}

export interface RunStepDoc extends TenantDoc {
  runId: string;
  seq: number;
  type: string;
  status: 'running' | 'succeeded' | 'failed';
  request?: unknown;
  response?: unknown;
  toolCalls?: unknown[];
  usage?: unknown;
  latencyMs?: number | null;
  error?: { code: string; message: string } | null;
  startedAt: Date;
  finishedAt?: Date | null;
}

export interface RunEventDoc extends TenantDoc {
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface ApprovalDoc extends TenantDoc {
  runId: string;
  runStepSeq: number;
  kind: string;
  payload: unknown;
  requestedAt: Date;
  expiresAt: Date;
  decision?: 'approve' | 'deny' | null;
  decidedBy?: string | null;
  decidedAt?: Date | null;
  response?: unknown;
}

export interface McpServerBindingDoc extends TenantDoc {
  mcpServerId: string;
  alias: string;
  credentialId?: string | null;
  perUserAuth: boolean;
  status: string;
  negotiatedProtocolVersion?: string | null;
  discovery?: {
    lastAt: Date;
    ttlMs?: number | null;
    cacheScope: string;
    capabilityCount: number;
  } | null;
  health: {
    lastOkAt?: Date | null;
    consecutiveFailures: number;
    circuitState: string;
    lastError?: string | null;
  };
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
}

export interface McpCapabilityDoc extends TenantDoc {
  bindingId: string;
  scopeKey: string;
  kind: string;
  name: string;
  canonicalName: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  annotations?: Record<string, unknown> | null;
  definitionHash: string;
  /** Embedded so a hash change invalidates approval in the SAME write. */
  approval: {
    state: 'pending' | 'approved' | 'revoked';
    definitionHash: string;
    approvedBy?: string | null;
    approvedAt?: Date | null;
  };
  firstSeenAt: Date;
  lastSeenAt: Date;
  removedAt?: Date | null;
}

export interface PolicyDoc extends TenantDoc {
  scopeType: string;
  scopeId?: string | null;
  rules: unknown[];
  updatedBy: string;
  updatedAt: Date;
}

export interface CredentialDoc extends TenantDoc {
  name: string;
  kind: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  wrappedDek: Uint8Array;
  keyProvider: string;
  kekVersion: number;
  metadata?: Record<string, unknown> | null;
  createdBy: string;
  createdAt: Date;
  rotatedAt?: Date | null;
  revokedAt?: Date | null;
}

export interface AuditLogDoc extends TenantDoc {
  actor: { type: string; id?: string | null };
  action: string;
  subject: { type: string; id?: string | null };
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  createdAt: Date;
}
