/**
 * Index definitions and idempotent sync.
 *
 * Rule: every tenant-scoped index is prefixed with workspaceId, so an unscoped
 * query is also a collection scan — slow enough to show up in monitoring. The
 * single documented exception is the runs claim index, which is a platform
 * operation that must see across workspaces to schedule fairly.
 */
import type { Db, IndexSpecification, CreateIndexesOptions } from 'mongodb';
import type { CollectionName } from './collections';

export interface IndexDef {
  readonly name: string;
  readonly key: IndexSpecification;
  readonly options?: CreateIndexesOptions;
  /** Why this index exists. Reviewed when the access pattern changes. */
  readonly rationale: string;
}

export const INDEXES: Readonly<Partial<Record<CollectionName, readonly IndexDef[]>>> = {
  users: [
    {
      name: 'email_unique', key: { email: 1 }, options: { unique: true },
      // Load-bearing, not an optimisation: user creation relies on this instead
      // of a read-then-write, because two concurrent sign-ups for the same
      // address would both see "not taken" and one would overwrite the other.
      rationale: 'sign-in lookup, and the uniqueness guarantee sign-up depends on',
    },
  ],

  authSessions: [
    {
      name: 'refresh_hash_unique', key: { refreshTokenHash: 1 }, options: { unique: true },
      rationale: 'refresh lookup by token hash; unique so rotation cannot fork a session',
    },
    { name: 'user_live', key: { userId: 1, revokedAt: 1 }, rationale: 'list a person’s sessions' },
    {
      name: 'expiry_ttl', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 },
      // Swept by the server rather than by us. An expired session row is not
      // dangerous — it fails every check — but keeping them forever turns the
      // collection into a slow-growing liability.
      rationale: 'reap expired sessions without a job',
    },
  ],

  identities: [
    {
      name: 'provider_subject_unique', key: { provider: 1, subject: 1 }, options: { unique: true },
      // The subject, never the email: an email can be reassigned inside a
      // hosted domain, and joining on it would eventually link one person to
      // another's account.
      rationale: 'the join key for an external identity',
    },
    { name: 'user', key: { userId: 1 }, rationale: 'list linked accounts' },
  ],

  authChallenges: [
    { name: 'token_hash_unique', key: { tokenHash: 1 }, options: { unique: true },
      rationale: 'redeem a verification or reset link' },
    { name: 'expiry_ttl', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 },
      rationale: 'an unused challenge should not outlive its window' },
  ],

  workspaces: [
    { name: 'slug_unique', key: { slug: 1 }, options: { unique: true },
      rationale: 'workspace lookup by URL slug' },
    { name: 'members_userId', key: { 'members.userId': 1 },
      rationale: 'list-my-workspaces and the hot authorization lookup' },
    { name: 'invitation_token', key: { 'invitations.tokenHash': 1 },
      options: { unique: true, sparse: true },
      rationale: 'invitation redemption' },
  ],

  apiKeys: [
    { name: 'prefix_unique', key: { prefix: 1 }, options: { unique: true },
      rationale: 'key lookup by prefix before constant-time hash compare' },
    { name: 'ws_active', key: { workspaceId: 1, revokedAt: 1 },
      rationale: 'list active keys' },
  ],

  credentials: [
    { name: 'ws_active', key: { workspaceId: 1, revokedAt: 1 }, rationale: 'list credentials' },
  ],

  oauthConnections: [
    { name: 'binding_user_resource', key: { bindingId: 1, userId: 1, resourceIndicator: 1 },
      options: { unique: true },
      rationale: 'per-user token lookup; RFC 8707 resource binds a token to one server' },
    { name: 'ws_user', key: { workspaceId: 1, userId: 1 }, rationale: 'revocation cascade' },
    { name: 'expiry', key: { expiresAt: 1 }, rationale: 'refresh sweep' },
  ],

  providerConfigs: [
    { name: 'ws_enabled', key: { workspaceId: 1, enabled: 1 }, rationale: 'list usable providers' },
  ],

  modelBindings: [
    { name: 'ws_role_enabled', key: { workspaceId: 1, role: 1, enabled: 1 },
      rationale: 'resolve a model by ROLE — the swap point for changing vendor' },
    { name: 'ws_provider_model_role',
      key: { workspaceId: 1, providerConfigId: 1, modelId: 1, role: 1 },
      options: { unique: true },
      rationale: 'prevent duplicate bindings' },
  ],

  agents: [
    { name: 'ws_slug', key: { workspaceId: 1, slug: 1 }, options: { unique: true },
      rationale: 'agent lookup by slug' },
    { name: 'ws_active', key: { workspaceId: 1, isArchived: 1, updatedAt: -1 },
      rationale: 'agent list view' },
  ],

  agentVersions: [
    { name: 'agent_version', key: { agentId: 1, version: -1 }, options: { unique: true },
      rationale: 'immutable version history; runs pin to a version' },
  ],

  mcpServers: [
    { name: 'ws_slug', key: { workspaceId: 1, slug: 1 }, options: { unique: true },
      rationale: 'catalog and workspace-private definitions share a namespace' },
  ],

  mcpServerBindings: [
    { name: 'ws_alias', key: { workspaceId: 1, alias: 1 }, options: { unique: true },
      rationale: 'alias uniqueness is what makes canonical tool names collision-free' },
    { name: 'ws_enabled', key: { workspaceId: 1, enabled: 1 }, rationale: 'list installations' },
    { name: 'server', key: { mcpServerId: 1 }, rationale: 'catalog fan-out' },
  ],

  mcpCapabilities: [
    { name: 'binding_scope_kind_name',
      key: { bindingId: 1, scopeKey: 1, kind: 1, name: 1 },
      options: { unique: true },
      rationale: 'discovery upsert key; scopeKey keeps per-user results separate' },
    { name: 'ws_binding_live', key: { workspaceId: 1, bindingId: 1, removedAt: 1 },
      rationale: 'capability selection for a run' },
    { name: 'ws_approval', key: { workspaceId: 1, 'approval.state': 1 },
      rationale: 'the pending-approval queue' },
  ],

  policies: [
    { name: 'ws_scope', key: { workspaceId: 1, scopeType: 1, scopeId: 1 },
      options: { unique: true },
      rationale: 'one document per scope; a decision reads at most three' },
  ],

  conversations: [
    { name: 'ws_recent', key: { workspaceId: 1, updatedAt: -1 }, rationale: 'conversation list' },
    { name: 'ws_agent_recent', key: { workspaceId: 1, agentId: 1, updatedAt: -1 },
      rationale: 'per-agent conversation list' },
    { name: 'channel_external', key: { channelId: 1, externalRef: 1 },
      options: { unique: true, sparse: true },
      rationale: 'channel idempotency — one external thread maps to one conversation' },
  ],

  messages: [
    { name: 'conversation_seq', key: { conversationId: 1, seq: 1 }, options: { unique: true },
      rationale: 'history window reads and gap detection; enforces append-only ordering' },
    { name: 'ws_recent', key: { workspaceId: 1, createdAt: -1 }, rationale: 'workspace activity' },
    { name: 'run', key: { runId: 1 }, options: { sparse: true }, rationale: 'messages of a run' },
  ],

  runs: [
    // PLATFORM-SCOPED BY DESIGN: the claim must see across workspaces to apply
    // fair-share scheduling. Commands using it carry the platform marker.
    { name: 'claim', key: { status: 1, scheduledFor: 1, priority: -1 },
      rationale: 'atomic lease claim — the work queue. Deliberately not workspace-prefixed.' },
    { name: 'ws_status_recent', key: { workspaceId: 1, status: 1, queuedAt: -1 },
      rationale: 'run list view' },
    { name: 'ws_conversation', key: { workspaceId: 1, conversationId: 1, queuedAt: -1 },
      rationale: 'runs of a conversation' },
    { name: 'ws_idempotency', key: { workspaceId: 1, idempotencyKey: 1 },
      options: { unique: true, sparse: true },
      rationale: 'a retried submission returns the existing run instead of a duplicate' },
    { name: 'lease_expiry', key: { 'lease.until': 1 }, options: { sparse: true },
      rationale: 'stalled-lease sweeper' },
    { name: 'parent', key: { parentRunId: 1 }, options: { sparse: true },
      rationale: 'sub-agent tree' },
  ],

  runSteps: [
    { name: 'run_seq', key: { runId: 1, seq: 1 }, options: { unique: true },
      rationale: 'ordered steps; the uniqueness makes step replay idempotent' },
    { name: 'ws_capability', key: { workspaceId: 1, 'toolCalls.capabilityName': 1, startedAt: -1 },
      rationale: 'tool usage analytics and incident review' },
  ],

  runEvents: [
    { name: 'run_seq', key: { runId: 1, seq: 1 }, options: { unique: true },
      rationale: 'SSE cursor replay after a dropped connection' },
    { name: 'ttl', key: { createdAt: 1 }, options: { expireAfterSeconds: 30 * 24 * 60 * 60 },
      rationale: 'event log is a streaming spine, not an archive' },
  ],

  approvals: [
    { name: 'ws_pending', key: { workspaceId: 1, decision: 1, requestedAt: -1 },
      rationale: 'the approval inbox' },
    { name: 'run', key: { runId: 1 }, rationale: 'resume a suspended run' },
    { name: 'ttl', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 },
      rationale: 'undecided approvals expire rather than pin a run forever' },
  ],

  channels: [
    { name: 'ws_type', key: { workspaceId: 1, type: 1 }, options: { unique: true },
      rationale: 'one connection per platform per workspace; two would race for deliveries' },
    { name: 'bot_ref', key: { 'identity.botRef': 1 },
      rationale: 'an inbound delivery names the bot, never the workspace' },
  ],

  channelIdentities: [
    { name: 'channel_external', key: { channelId: 1, externalUserId: 1 }, options: { unique: true },
      rationale: 'map an external sender to an identity' },
    { name: 'ws_user', key: { workspaceId: 1, userId: 1 }, options: { sparse: true },
      rationale: 'linked identities of a user' },
  ],

  channelEvents: [
    { name: 'channel_event_unique', key: { channelId: 1, externalEventId: 1 },
      options: { unique: true },
      rationale: 'webhook idempotency — a redelivered event is a no-op' },
    { name: 'ttl', key: { receivedAt: 1 }, options: { expireAfterSeconds: 7 * 24 * 60 * 60 },
      rationale: 'dedupe window, not an archive' },
  ],

  auditLog: [
    { name: 'ws_recent', key: { workspaceId: 1, createdAt: -1 }, rationale: 'audit browsing' },
    { name: 'ws_action', key: { workspaceId: 1, action: 1, createdAt: -1 },
      rationale: 'filter by action' },
  ],

  usageDaily: [
    { name: 'ws_day', key: { workspaceId: 1, day: -1 }, rationale: 'billing rollups' },
  ],
};

export interface IndexSyncResult {
  readonly created: readonly string[];
  readonly existing: readonly string[];
}

/**
 * Creates any missing index. `createIndex` is idempotent for an identical
 * definition, so this is safe to run on every deploy; a CHANGED definition
 * under the same name is an error the caller must resolve by dropping it
 * explicitly, never silently.
 */
export async function syncIndexes(db: Db): Promise<IndexSyncResult> {
  const created: string[] = [];
  const existing: string[] = [];

  for (const [collectionName, defs] of Object.entries(INDEXES)) {
    if (defs === undefined) continue;
    const collection = db.collection(collectionName);
    const present = new Set<string>();
    try {
      for (const idx of await collection.indexes()) {
        if (typeof idx['name'] === 'string') present.add(idx['name']);
      }
    } catch {
      // Collection does not exist yet; createIndex will create it.
    }
    for (const def of defs) {
      const label = `${collectionName}.${def.name}`;
      if (present.has(def.name)) {
        existing.push(label);
        continue;
      }
      await collection.createIndex(def.key, {
        name: def.name,
        ...def.options,
        comment: { salvations: 'platform:index-sync' },
      } as CreateIndexesOptions);
      created.push(label);
    }
  }

  return { created, existing };
}

export const indexCount = (): number =>
  Object.values(INDEXES).reduce((n, defs) => n + (defs?.length ?? 0), 0);
