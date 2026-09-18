/**
 * Principals — everything that can act. There is no ambient authority.
 */
import type { AgentId, ApiKeyId, RunId, UserId, WorkspaceId } from '../ids';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({
  viewer: 0, member: 1, admin: 2, owner: 3,
});

export type Permission =
  | 'workspace:read' | 'workspace:manage' | 'workspace:delete'
  | 'members:read' | 'members:manage'
  | 'agents:read' | 'agents:write'
  | 'mcp:read' | 'mcp:install' | 'mcp:approve'
  | 'policies:read' | 'policies:write'
  | 'credentials:read' | 'credentials:write'
  | 'providers:read' | 'providers:write'
  | 'conversations:read' | 'conversations:write'
  | 'runs:read' | 'runs:create' | 'runs:cancel'
  | 'approvals:decide'
  | 'channels:read' | 'channels:write'
  | 'knowledge:read' | 'knowledge:write'
  | 'audit:read';

const VIEWER: readonly Permission[] = [
  'workspace:read', 'members:read', 'agents:read', 'mcp:read',
  'policies:read', 'providers:read', 'conversations:read', 'runs:read',
  'channels:read', 'knowledge:read',
];

const MEMBER: readonly Permission[] = [
  ...VIEWER, 'conversations:write', 'runs:create', 'runs:cancel', 'approvals:decide',
  // Uploading what the agents should know is everyday work, not administration.
  'knowledge:write',
];

const ADMIN: readonly Permission[] = [
  ...MEMBER, 'workspace:manage', 'members:manage', 'agents:write',
  'mcp:install', 'mcp:approve', 'policies:write',
  'credentials:read', 'credentials:write', 'providers:write', 'audit:read',
  // Connecting a chat platform stores a bot token and points an agent at a
  // public endpoint. That is administrative, not something a member does.
  'channels:write',
];

const OWNER: readonly Permission[] = [...ADMIN, 'workspace:delete'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  viewer: Object.freeze(VIEWER),
  member: Object.freeze(MEMBER),
  admin: Object.freeze(ADMIN),
  owner: Object.freeze(OWNER),
});

export type Principal =
  | { readonly type: 'user'; readonly userId: UserId; readonly workspaceId: WorkspaceId; readonly role: Role }
  | { readonly type: 'api_key'; readonly apiKeyId: ApiKeyId; readonly workspaceId: WorkspaceId; readonly scopes: readonly Permission[] }
  | {
      readonly type: 'channel_identity';
      readonly identityId: string;
      readonly workspaceId: WorkspaceId;
      readonly userId?: UserId;
      readonly trust: 'linked' | 'unlinked';
    }
  /** Delegated authority only. An agent never holds grants of its own. */
  | {
      readonly type: 'agent';
      readonly agentId: AgentId;
      readonly runId: RunId;
      readonly workspaceId: WorkspaceId;
      readonly onBehalfOf: Principal;
    }
  | { readonly type: 'system'; readonly reason: 'sweeper' | 'migration'; readonly workspaceId?: WorkspaceId };

/** Grants held directly by a principal, before delegation is applied. */
export function directGrants(p: Principal): readonly Permission[] {
  switch (p.type) {
    case 'user':
      return ROLE_PERMISSIONS[p.role];
    case 'api_key':
      return p.scopes;
    case 'channel_identity':
      // An unlinked channel user is a stranger, not a member.
      return p.trust === 'linked'
        ? ['conversations:read', 'conversations:write', 'runs:create', 'runs:read']
        : ['conversations:write', 'runs:create'];
    case 'agent':
      return effectiveGrants(p);
    case 'system':
      return [];
  }
}

/**
 * The anti-escalation invariant:
 *
 *   effective(agent) = grants(agent) ∩ grants(onBehalfOf)
 *
 * An agent can never exceed the person or key that triggered it, at any
 * delegation depth.
 */
export function effectiveGrants(p: Principal): readonly Permission[] {
  if (p.type !== 'agent') return directGrants(p);
  const delegated = new Set(effectiveGrants(p.onBehalfOf));
  // An agent's own ceiling: it may act within a conversation, never administer.
  const agentCeiling: readonly Permission[] = [
    'conversations:read', 'conversations:write', 'runs:read', 'runs:create',
    'agents:read', 'mcp:read', 'providers:read', 'policies:read',
  ];
  return agentCeiling.filter((perm) => delegated.has(perm));
}

export const hasPermission = (p: Principal, needed: Permission): boolean =>
  effectiveGrants(p).includes(needed);

/** The human ultimately responsible, for audit and revocation checks. */
export function rootUserId(p: Principal): UserId | undefined {
  switch (p.type) {
    case 'user': return p.userId;
    case 'channel_identity': return p.userId;
    case 'agent': return rootUserId(p.onBehalfOf);
    default: return undefined;
  }
}

export function workspaceOf(p: Principal): WorkspaceId | undefined {
  return p.type === 'system' ? p.workspaceId : p.workspaceId;
}
