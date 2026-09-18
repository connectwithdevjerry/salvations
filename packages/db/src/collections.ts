/**
 * The collection registry.
 *
 * Tenancy classification lives here because the guard (guard.ts) needs to know,
 * for any command it observes, whether a missing workspaceId is a bug or normal.
 * Adding a collection without classifying it is a type error.
 */

/**
 * Authentication. Global by design: one human belongs to many workspaces, so a
 * user record cannot be scoped to any one of them.
 *
 * Owned by us, not by an auth vendor — every fact about a person lives here and
 * nowhere else.
 */
export const GLOBAL_COLLECTIONS = [
  /** People. Email, password hash, profile. */
  'users',
  /** Live sessions. Deleting a row revokes a session. */
  'authSessions',
  /** Links to an external identity provider — a Google account. */
  'identities',
  /** Email verification and password reset challenges. */
  'authChallenges',
] as const;

/** Every document belongs to exactly one workspace. */
export const TENANT_COLLECTIONS = [
  'workspaces',
  'apiKeys',
  'credentials',
  'oauthConnections',
  'providerConfigs',
  'modelBindings',
  'agents',
  'agentVersions',
  'mcpServerBindings',
  'mcpCapabilities',
  'policies',
  'conversations',
  'messages',
  'runs',
  'runSteps',
  'runEvents',
  'approvals',
  'channels',
  'channelIdentities',
  'channelEvents',
  'auditLog',
  'usageDaily',
  'subscriptions',
  'schedules',
  'memoryEntries',
  'knowledgeDocuments',
  'knowledgeChunks',
] as const;

/**
 * Documents may be workspace-owned OR platform catalog entries (workspaceId
 * absent). A read here must either scope to a workspace or declare itself a
 * platform operation.
 */
export const MIXED_COLLECTIONS = ['mcpServers'] as const;

export type GlobalCollection = (typeof GLOBAL_COLLECTIONS)[number];
export type TenantCollection = (typeof TENANT_COLLECTIONS)[number];
export type MixedCollection = (typeof MIXED_COLLECTIONS)[number];
export type CollectionName = GlobalCollection | TenantCollection | MixedCollection;

const TENANT_SET: ReadonlySet<string> = new Set(TENANT_COLLECTIONS);
const GLOBAL_SET: ReadonlySet<string> = new Set(GLOBAL_COLLECTIONS);
const MIXED_SET: ReadonlySet<string> = new Set(MIXED_COLLECTIONS);

export type Tenancy = 'tenant' | 'global' | 'mixed' | 'unknown';

export function tenancyOf(collection: string): Tenancy {
  if (TENANT_SET.has(collection)) return 'tenant';
  if (GLOBAL_SET.has(collection)) return 'global';
  if (MIXED_SET.has(collection)) return 'mixed';
  return 'unknown';
}

export const isTenantCollection = (c: string): c is TenantCollection => TENANT_SET.has(c);

export const ALL_COLLECTIONS: readonly CollectionName[] = [
  ...GLOBAL_COLLECTIONS,
  ...TENANT_COLLECTIONS,
  ...MIXED_COLLECTIONS,
];
