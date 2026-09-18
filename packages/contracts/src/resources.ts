/**
 * Per-resource contracts.
 *
 * Grouped by what a person is doing rather than by table: the UI asks for "the
 * things I can run an agent with", not for a join.
 */
import { z } from 'zod';
import {
  aliasSchema, boundedText, budgetRequestSchema, consumptionSchema, contentBlockSchema,
  descriptionSchema, idSchema, nameSchema, permissionEffectSchema, roleSchema, runStatusSchema,
  trustTierSchema, usageSchema,
} from './common';

// ─── Workspaces and membership ──────────────────────────────────────────────

export const workspaceSchema = z.object({
  id: idSchema,
  name: nameSchema,
  slug: z.string(),
  role: roleSchema,
});

/**
 * Optional, because onboarding does not ask.
 *
 * Somebody with one workspace who will only ever have one should not spend a
 * step naming it. Absent, the server derives one from who they are.
 */
export const createWorkspaceSchema = z.object({ name: nameSchema.optional() });

export const inviteMemberSchema = z.object({
  email: z.string().email().max(320),
  role: roleSchema,
});

export const memberSchema = z.object({
  userId: idSchema,
  email: z.string(),
  name: z.string().optional(),
  role: roleSchema,
  joinedAt: z.string(),
});

/**
 * An API key is returned in full EXACTLY once.
 *
 * Storing it would defeat hashing it, so the response type says so in its shape
 * rather than in a comment someone has to find.
 */
export const createdApiKeySchema = z.object({
  id: idSchema,
  name: nameSchema,
  prefix: z.string(),
  secret: z.string().describe('shown once and never again'),
  createdAt: z.string(),
});

export const apiKeySchema = z.object({
  id: idSchema,
  name: nameSchema,
  prefix: z.string(),
  lastUsedAt: z.string().optional(),
  createdAt: z.string(),
  revokedAt: z.string().optional(),
});

export const createApiKeySchema = z.object({
  name: nameSchema,
  scopes: z.array(z.string()).max(40).optional(),
});

// ─── Providers and models ───────────────────────────────────────────────────

/**
 * Registering a provider.
 *
 * `providerType` is a free string, not an enum: `packages/core` refuses to
 * enumerate vendors, and an enum here would put the list back — in the one
 * place every client would copy it from.
 */
/**
 * Connecting a chat platform.
 *
 * `token` and `signingSecret` are both secrets and both go straight into
 * encrypted storage; the schema bounds them only so a paste of an entire
 * document cannot become a 40MB credential row.
 */
export const connectChannelSchema = z.object({
  /** A catalogue id: telegram, discord, slack. */
  channel: z.string().trim().min(1).max(40),
  token: z.string().trim().min(1).max(500),
  /** Slack's signing secret, Discord's public key. Absent for Telegram. */
  signingSecret: z.string().trim().min(1).max(500).optional(),
  agentId: idSchema,
  /** Omitted, the channel follows the agent's model role rather than pinning one. */
  modelBindingId: idSchema.optional(),
});

export const channelSchema = z.object({
  id: idSchema,
  channel: z.string(),
  status: z.enum(['pending_verification', 'connected', 'error', 'disabled']),
  handle: z.string(),
  displayName: z.string(),
  agentId: idSchema,
  webhookUrl: z.string(),
  /** Only while the handshake is outstanding. Never for a live connection. */
  connectCode: z.string().optional(),
  lastError: z.string().optional(),
});

/**
 * A recurring instruction.
 *
 * The expression and the zone are validated for SHAPE here and for MEANING at
 * the boundary, which owns the cron parser. A schema that accepted any string
 * would store a schedule that fails silently every minute for ever.
 */
export const createScheduleSchema = z.object({
  name: nameSchema,
  expression: z.string().trim().min(1).max(120),
  timeZone: z.string().trim().min(1).max(64).default('UTC'),
  agentId: idSchema,
  modelBindingId: idSchema,
  prompt: boundedText(4_000),
});

/**
 * Knowledge typed in rather than uploaded — a paragraph somebody wants the
 * agents to know without making a file of it.
 */
export const createKnowledgeTextSchema = z.object({
  title: nameSchema,
  text: boundedText(200_000),
});

export const knowledgeSearchSchema = z.object({
  q: z.string().trim().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export const modelRoleSchema = z.enum([
  'chat', 'reasoning', 'summarizer', 'cheap', 'embedding', 'transcription',
]);

export const createProviderConfigSchema = z.object({
  providerType: z.string().trim().min(1).max(40),
  name: nameSchema,
  apiKey: z.string().min(1).max(500),
  baseUrl: z.string().url().optional(),
  /** Which catalogue model to bind to the chat role, when not the vendor's default. */
  chatModelId: z.string().trim().min(1).max(80).optional(),
});

export const providerConfigSchema = z.object({
  id: idSchema,
  providerType: z.string(),
  name: nameSchema,
  baseUrl: z.string().optional(),
  /** Never the key itself — only enough to tell two apart. */
  keyHint: z.string(),
  createdAt: z.string(),
});

export const createModelBindingSchema = z.object({
  providerConfigId: idSchema,
  modelId: z.string().trim().min(1).max(120),
  name: nameSchema,
  role: modelRoleSchema.default('chat'),
  fallbackBindingId: idSchema.optional(),
  maxOutputTokens: z.number().int().min(1).max(200_000).optional(),
  rates: z.object({
    inputPerMTok: z.number().min(0),
    outputPerMTok: z.number().min(0),
    cacheReadPerMTok: z.number().min(0).optional(),
    cacheWritePerMTok: z.number().min(0).optional(),
  }).optional(),
});

export const modelBindingSchema = z.object({
  id: idSchema,
  name: nameSchema,
  providerType: z.string(),
  modelId: z.string(),
  role: z.string(),
  fallbackBindingId: idSchema.optional(),
  /** Read from the adapter, never typed in by a person. */
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

// ─── Agents ─────────────────────────────────────────────────────────────────

export const capabilityBindingSchema = z.object({
  bindingId: idSchema,
  mode: z.enum(['all', 'allow', 'deny']),
  tools: z.array(z.string().max(120)).max(200).default([]),
});


/**
 * An agent names a ROLE, not a model binding.
 *
 * The role is resolved to a binding when a run starts, which is the point at
 * which a workspace can swap vendors without editing every agent. A conversation
 * may then override the binding for itself — that is how one conversation
 * continues across Anthropic, OpenAI and Google.
 */
export const upsertAgentSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  /**
   * Optional. Absent, the boundary applies the default.
   *
   * Nobody should have to write a system prompt to get started: it is a blank
   * page at the moment somebody has least idea what to put on it. The default
   * is stored on the agent like any other, so it stays visible and editable.
   */
  systemPrompt: boundedText(20_000).optional(),
  modelRole: modelRoleSchema.default('chat'),
  capabilityBindings: z.array(capabilityBindingSchema).max(50).default([]),
  budget: budgetRequestSchema.optional(),
  guardrails: z.object({
    maxToolCallsPerTurn: z.number().int().min(0).max(50).default(8),
  }).optional(),
});

export const agentSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  systemPrompt: z.string(),
  modelRole: modelRoleSchema,
  capabilityBindings: z.array(capabilityBindingSchema),
  versionId: idSchema,
  version: z.number().int().min(1),
  updatedAt: z.string(),
});

// ─── MCP ────────────────────────────────────────────────────────────────────

export const installMcpServerSchema = z.object({
  /** A catalogue integration (its id), a platform server, or a URL. One of the three. */
  catalogId: z.string().trim().min(1).max(40).optional(),
  mcpServerId: idSchema.optional(),
  url: z.string().url().optional(),
  name: nameSchema.optional(),
  /** Defaults to the catalogue id when connecting a catalogue integration. */
  alias: aliasSchema.optional(),
  perUserAuth: z.boolean().default(false),
  headers: z.record(z.string(), z.string()).optional(),
}).refine(
  (value) => value.catalogId !== undefined || value.mcpServerId !== undefined || value.url !== undefined,
  { message: 'Name a catalogue integration, a catalog server, or supply a URL.' },
).refine(
  (value) => value.catalogId !== undefined || value.alias !== undefined,
  { message: 'An alias is required unless connecting a catalogue integration.' },
);

export const mcpBindingSchema = z.object({
  id: idSchema,
  alias: aliasSchema,
  serverName: z.string(),
  url: z.string().optional(),
  trustTier: trustTierSchema,
  status: z.enum(['pending_auth', 'connected', 'error', 'disabled']),
  perUserAuth: z.boolean(),
  negotiatedProtocolVersion: z.string().optional(),
  capabilityCount: z.number().int().min(0),
  health: z.object({
    circuitState: z.enum(['closed', 'open', 'half_open']),
    consecutiveFailures: z.number().int().min(0),
    lastOkAt: z.string().optional(),
    lastError: z.string().optional(),
  }),
});

export const capabilitySchema = z.object({
  id: idSchema,
  bindingId: idSchema,
  kind: z.enum(['tool', 'resource', 'resource_template', 'prompt']),
  name: z.string(),
  canonicalName: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  definitionHash: z.string(),
  approval: z.object({
    state: z.enum(['pending', 'approved', 'revoked']),
    definitionHash: z.string(),
    approvedAt: z.string().optional(),
  }),
  /**
   * Why this capability cannot currently be called.
   *
   * Carried on the resource itself so the UI never has to re-derive the rule
   * and never disagrees with the gateway about it.
   */
  blockedReason: z.enum(['removed', 'not_approved', 'capability_changed']).optional(),
  removedAt: z.string().optional(),
});

/**
 * What changed since a capability was approved.
 *
 * The description reaches the model's context, so a silent rewrite is an
 * injection vector as much as a capability change — which is why the diff shows
 * prose and schema side by side rather than only the schema.
 */
export const capabilityDiffSchema = z.object({
  canonicalName: z.string(),
  approvedHash: z.string(),
  currentHash: z.string(),
  changes: z.array(z.object({
    field: z.enum(['title', 'description', 'inputSchema', 'outputSchema', 'annotations']),
    before: z.unknown(),
    after: z.unknown(),
  })),
});

export const approveCapabilitiesSchema = z.object({
  capabilityIds: z.array(idSchema).min(1).max(500),
  /** Must match what the reviewer was shown; a changed hash means re-review. */
  expectedHashes: z.record(z.string(), z.string()),
});

// ─── Policies ───────────────────────────────────────────────────────────────

export const policyRuleSchema = z.object({
  id: z.string().max(60),
  effect: permissionEffectSchema,
  /** Glob over canonical names — `calendar__*`, `*__delete_*`. */
  pattern: z.string().min(1).max(200),
  priority: z.number().int().min(0).max(1000).default(0),
  /** Absolute rules cannot be overridden by a higher priority elsewhere. */
  absolute: z.boolean().default(false),
  reason: descriptionSchema.optional(),
});

export const upsertPolicySchema = z.object({
  name: nameSchema,
  defaultEffect: permissionEffectSchema.default('ask'),
  rules: z.array(policyRuleSchema).max(200).default([]),
  appliesTo: z.object({
    agentIds: z.array(idSchema).max(100).optional(),
    bindingIds: z.array(idSchema).max(100).optional(),
  }).optional(),
});

// ─── Conversations and runs ─────────────────────────────────────────────────

export const createConversationSchema = z.object({
  agentId: idSchema,
  title: nameSchema.optional(),
  /** Overrides the agent's role resolution for this conversation only. */
  modelBindingId: idSchema.optional(),
});

export const conversationSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  title: z.string(),
  modelBindingId: idSchema,
  messageCount: z.number().int().min(0),
  updatedAt: z.string(),
});

export const messageSchema = z.object({
  id: idSchema,
  seq: z.number().int().min(0),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.array(contentBlockSchema),
  runId: idSchema.optional(),
  createdAt: z.string(),
  supersededBy: idSchema.optional(),
});

export const sendMessageSchema = z.object({
  content: boundedText(100_000),
  /** Continue the same conversation on a different model. */
  modelBindingId: idSchema.optional(),
  budget: budgetRequestSchema.optional(),
  idempotencyKey: z.string().max(200).optional(),
});

export const runSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  agentId: idSchema,
  status: runStatusSchema,
  modelBindingId: idSchema,
  consumed: consumptionSchema,
  usage: usageSchema,
  attempts: z.number().int().min(0),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  queuedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

export const runStepSchema = z.object({
  seq: z.number().int().min(0),
  type: z.enum(['model_call', 'tool_call', 'compaction', 'input_required', 'memory_write', 'subagent']),
  status: z.enum(['running', 'succeeded', 'failed']),
  usage: usageSchema.optional(),
  latencyMs: z.number().int().min(0).optional(),
  toolCalls: z.array(z.object({
    id: z.string(),
    capabilityName: z.string(),
    isError: z.boolean(),
    durationMs: z.number().int().min(0),
    mrtrRounds: z.number().int().min(0),
    permissionDecision: z.object({
      effect: permissionEffectSchema,
      reason: z.string().optional(),
    }),
  })).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});

// ─── Approvals ──────────────────────────────────────────────────────────────

export const approvalSchema = z.object({
  id: idSchema,
  runId: idSchema,
  kind: z.enum(['tool_call', 'mrtr_input', 'budget_increase']),
  payload: z.unknown(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  decision: z.enum(['approve', 'deny']).optional(),
});

export const decideApprovalSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  /** For an MRTR question: what the person answered. */
  response: z.unknown().optional(),
});

// ─── Credentials ────────────────────────────────────────────────────────────

export const createCredentialSchema = z.object({
  name: nameSchema,
  kind: z.enum(['api_key', 'bearer', 'basic', 'custom']),
  value: z.string().min(1).max(8_000),
  bindingId: idSchema.optional(),
});

/** A credential NEVER round-trips its value. There is no field for it. */
export const credentialSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.string(),
  bindingId: idSchema.optional(),
  keyVersion: z.number().int().min(1),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});

// ─── Health ─────────────────────────────────────────────────────────────────

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.record(z.string(), z.object({
    ok: z.boolean(),
    detail: z.string().optional(),
    latencyMs: z.number().optional(),
  })),
  version: z.string().optional(),
});
