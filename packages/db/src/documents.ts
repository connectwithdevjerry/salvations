/**
 * BSON document shapes.
 *
 * These are the storage representation, kept deliberately separate from the
 * domain types in @salvations/core. Mappers translate between them, so a
 * storage change never ripples into the domain and `_id` never leaks upward.
 */
import type { Document } from 'mongodb';
import type { TenantDocument } from './scoped';

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

/**
 * One tool call, as persisted.
 *
 * Carries BOTH halves deliberately: the result, so a suspended phase can replay
 * instead of repeating a side effect, and the decision and redacted arguments,
 * so a reviewer can answer "why was this allowed" without re-deriving it
 * against a policy that has since changed.
 */
export interface ToolInvocationDoc {
  id: string;
  canonicalName: string;
  bindingId?: string | null;
  content?: unknown[];
  structured?: unknown;
  isError: boolean;
  durationMs: number;
  mrtrRounds: number;
  /** Redacted at WRITE time. A display-time redaction is one call site from a leak. */
  argumentsRedacted?: unknown;
  permission?: {
    effect: 'allow' | 'ask' | 'deny';
    reason?: string | null;
    matchedRuleId?: string | null;
  } | null;
}

export interface RunStepDoc extends TenantDoc {
  runId: string;
  seq: number;
  type: string;
  status: 'running' | 'succeeded' | 'failed';
  request?: unknown;
  response?: unknown;
  toolCalls?: ToolInvocationDoc[];
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

/**
 * A connected chat platform.
 *
 * Two secrets, both encrypted, because they do different jobs and rotate
 * independently: the token authorises calls we make, and the webhook secret
 * proves a delivery came from the platform. Storing them as one field would
 * mean rotating a leaked signing secret revokes the bot as well.
 *
 * `verifiedChatRef` is the whole of the ownership proof. Anyone can paste a bot
 * token; only the person who can message that bot can complete the handshake,
 * and until they do the connection answers nobody.
 */
export interface ChannelDoc extends TenantDoc {
  /** A catalogue id — 'telegram', 'discord', 'slack'. */
  type: string;
  /** Which agent answers here. A channel with no agent has nothing to say. */
  agentId: string;
  /**
   * A binding to pin conversations to, or null to follow the agent's role.
   *
   * Null is the normal case and the better one. An agent names a model ROLE and
   * the workspace maps roles to bindings; a channel pinning a concrete binding
   * duplicates that mapping, so swapping vendor would mean editing every
   * channel as well as the binding it was supposed to be the single point of.
   *
   * It also means a channel can be connected before any model exists, which is
   * what lets somebody set up Telegram in the first minute rather than being
   * told to go and find an API key first.
   */
  modelBindingId?: string | null;
  tokenCredentialId: string;
  /** Absent for a platform whose deliveries carry no secret at all. */
  secretCredentialId?: string | null;
  status: 'pending_verification' | 'connected' | 'error' | 'disabled';
  /** Who the bot is on that platform. Display only — never an authorisation. */
  identity: {
    handle: string;
    displayName: string;
    botRef: string;
  };
  /**
   * The one-time code that proves the chat is theirs, and when it stops being
   * accepted. Cleared the moment it is used, so a code cannot be replayed.
   */
  connect: {
    code: string;
    expiresAt: Date;
  } | null;
  /** Set once the handshake completes. Until then nothing is answered. */
  verifiedChatRef?: string | null;
  health: {
    lastOkAt?: Date | null;
    lastDeliveryAt?: Date | null;
    consecutiveFailures: number;
    lastError?: string | null;
  };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A person on a chat platform, and the conversation their messages belong to.
 *
 * Keyed by the platform's own sender id, which identifies and never authorises:
 * it says which thread to continue, not what the thread is allowed to do. The
 * authority for anything a run does still comes from the channel's own
 * principal, not from whoever sent the message.
 */
export interface ChannelIdentityDoc extends TenantDoc {
  channelId: string;
  /** The platform's id for the person. */
  externalUserId: string;
  /** The platform's id for the chat, which is where a reply goes. */
  chatRef: string;
  conversationId: string;
  label: string;
  /** Set only when a platform account has been linked to a HIVE account. */
  userId?: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

/**
 * One inbound delivery.
 *
 * A unique index on (channelId, externalEventId) is what makes a redelivery a
 * no-op: the second insert collides instead of starting a second run. Every one
 * of these platforms retries on a slow response, so without it a timeout would
 * silently double every answer.
 *
 * Rows expire after a week. The dedupe window only has to outlive a platform's
 * retry schedule, and keeping them forever would turn a safety mechanism into
 * the largest collection in the database.
 */
export interface ChannelEventDoc extends TenantDoc {
  channelId: string;
  externalEventId: string;
  outcome: string;
  runId?: string | null;
  /** Also the TTL anchor: this is a dedupe window, not an archive. */
  receivedAt: Date;
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

/**
 * What a workspace is paying for.
 *
 * One row per workspace, and the processor's own record is the source of truth:
 * this is a cache of it, refreshed by webhook. That direction matters — a local
 * row treated as authoritative diverges the first time a webhook is missed, and
 * then the platform is billing on its own opinion rather than on what was
 * actually charged.
 *
 * No card details, no last four, no expiry. Everything about the payment
 * instrument stays with the processor; holding any of it here would put this
 * system in PCI scope for no benefit at all.
 */
export interface SubscriptionDoc extends TenantDoc {
  planId: string;
  /** The processor's id. The only handle we have on their record. */
  externalId: string;
  processor: string;
  status: string;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A recurring instruction.
 *
 * `lastFiredFor` is the wall-clock instant of the last occurrence acted on, not
 * the time the tick ran. That distinction is what makes catching up safe: a
 * scheduler that has been down walks the minutes it missed and compares each
 * against this, so a missed 09:00 fires once and a fall-back DST hour's
 * repeated 01:30 does not fire twice.
 */
export interface ScheduleDoc extends TenantDoc {
  name: string;
  /** Five-field cron. Validated at the boundary, never trusted from the row. */
  expression: string;
  /** IANA zone. "09:00" means nothing without it. */
  timeZone: string;
  agentId: string;
  modelBindingId: string;
  /** What to say to the agent when it fires. */
  prompt: string;
  enabled: boolean;
  lastFiredFor?: Date | null;
  lastRunId?: string | null;
  /**
   * Consecutive failures to START a run — not runs that failed.
   *
   * A schedule pointed at a deleted agent would otherwise fail silently every
   * minute for ever.
   */
  consecutiveFailures: number;
  lastError?: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Something an agent remembers.
 *
 * Never updated — only superseded. A correction writes a new row and closes
 * the old one, so "why did it believe that in March?" stays answerable and a
 * wrong correction is recoverable. That is worth the extra rows: the failure
 * mode of updating in place is a belief silently rewritten with no way back.
 *
 * `embeddings` is keyed by the MODEL that produced each vector, not by a single
 * field. Two models put the same sentence in two unrelated spaces, so a cosine
 * between them is a number with no meaning — keying them apart is what makes
 * that mistake impossible to make by accident, and it also means re-embedding
 * on a new model is an additive write rather than a rebuild.
 */
export interface MemoryEntryDoc extends TenantDoc {
  /** Per AGENT. Memory that ended with a conversation would not be memory. */
  agentId: string;
  kind: string;
  /** A stable handle for a recurring belief, and the only supersession key. */
  key?: string | null;
  content: string;
  importance: number;
  sourceRunId?: string | null;
  createdBy?: string | null;
  validFrom: Date;
  /** Null while current. */
  validTo?: Date | null;
  supersededBy?: string | null;
  /** `{ openai_text_embedding_3_large: [...] }` — never a bare vector field. */
  embeddings?: Record<string, number[]> | null;
}

/**
 * A document somebody uploaded for the workspace's agents to know.
 *
 * Scoped to the WORKSPACE. Knowledge is the business context, uploaded before
 * any agent exists and shared by all of them; a second agent should not have
 * to be taught what the first one was.
 */
export interface KnowledgeDocumentDoc extends TenantDoc {
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256 of the extracted text. Unique per workspace while the document lives. */
  contentHash: string;
  status: 'ingesting' | 'ready' | 'failed';
  error?: string | null;
  chunkCount: number;
  /** Which model embedded the chunks, or null when none was bound at upload. */
  embeddingModelKey?: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One searchable piece of a document.
 *
 * `embeddings` is keyed by model exactly as memory's is, and for the same
 * reason: vectors from two models are two unrelated spaces.
 */
export interface KnowledgeChunkDoc extends TenantDoc {
  documentId: string;
  index: number;
  content: string;
  embeddings?: Record<string, number[]> | null;
  createdAt: Date;
}

/**
 * OAuth credentials for one connection scope.
 *
 * One row per scope key — a workspace-wide binding, or one person's use of a
 * per-user binding — holding everything the OAuth client provider stores for
 * it. Token sets are encrypted under the workspace's envelope exactly as API
 * keys are: a bearer token for somebody's GitHub is a credential, whatever
 * the standard that issued it.
 */
export interface OAuthConnectionDoc extends TenantDoc {
  /** `scopeKeyString` of the connection scope. */
  scopeKey: string;
  bindingId: string;
  /** The person, or `workspace` for a shared binding. Part of the unique key. */
  userId: string;
  /** Kept null: one row per scope, and the index needs the field. */
  resourceIndicator?: string | null;
  /** Registered client information, keyed by issuer. Public, not secret. */
  clients?: Record<string, unknown> | null;
  /** Encrypted token sets, keyed by issuer. */
  tokens?: Record<string, EncryptedBlob> | null;
  /** Which issuer's tokens the transport should present when it names none. */
  latestIssuer?: string | null;
  /** An authorization in flight: state, verifier, where the person was sent. */
  pending?: {
    state: string;
    codeVerifier: EncryptedBlob;
    authorizationUrl?: string | null;
    createdAt: number;
  } | null;
  discovery?: Record<string, unknown> | null;
  updatedAt: Date;
}

/** An envelope-encrypted value, stored inline. */
export interface EncryptedBlob {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  wrappedDek: Uint8Array;
  keyProvider: string;
  kekVersion: number;
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

/**
 * A person.
 *
 * Global, not workspace-scoped: one human belongs to many workspaces, and a
 * per-workspace user row would mean the same person with several passwords.
 */
export interface UserDoc extends BaseDoc {
  /** Lowercased and trimmed. The unique index is on this, not on the display form. */
  email: string;
  /** As typed, for display. `Sam@Example.com` should still greet them that way. */
  emailDisplay: string;
  emailVerifiedAt?: Date | null;
  name?: string | null;
  imageUrl?: string | null;
  /**
   * Absent for someone who only ever signs in with Google.
   *
   * Nullable rather than a placeholder: a dummy hash would be indistinguishable
   * from a real one, and "this account has no password" is a fact worth being
   * able to state.
   */
  passwordHash?: string | null;
  /** Bumped to revoke every session at once — a password change, a compromise. */
  sessionEpoch: number;
  disabledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastSignedInAt?: Date | null;
}

/**
 * A live session.
 *
 * The row IS the session: deleting it revokes the refresh token immediately,
 * and the short-lived access token lapses on its own within minutes.
 */
export interface AuthSessionDoc extends BaseDoc {
  userId: string;
  /** SHA-256 of the refresh token. The token itself is never stored. */
  refreshTokenHash: string;
  /** Matched against the user's epoch, so one write can revoke every session. */
  sessionEpoch: number;
  /** Rotated on every refresh; a reused old token means a stolen one. */
  rotatedAt: Date;
  createdAt: Date;
  /** Hard stop. A session cannot be refreshed forever. */
  expiresAt: Date;
  /** Sliding window: an active session stays alive, an idle one lapses. */
  idleExpiresAt: Date;
  /** For a sessions list a person can review — never used for authorization. */
  userAgent?: string | null;
  ipHash?: string | null;
  revokedAt?: Date | null;
  revokedReason?: string | null;
}

/** A link between a person here and an account at an identity provider. */
export interface IdentityDoc extends BaseDoc {
  userId: string;
  provider: 'google';
  /**
   * The provider's stable subject, never the email.
   *
   * An email can be reassigned inside a hosted domain; the subject is stable
   * for the life of the account. Joining on email would eventually hand one
   * person another's account.
   */
  subject: string;
  email: string;
  emailVerified: boolean;
  hostedDomain?: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface AuthChallengeDoc extends BaseDoc {
  userId: string;
  kind: 'email_verification' | 'password_reset';
  /** Hashed, like every other bearer value. */
  tokenHash: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
}
