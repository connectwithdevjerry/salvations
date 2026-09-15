/**
 * MCP capability entities.
 *
 * Capability approval is embedded on the capability itself so that a change to
 * the definition invalidates approval in the same write — there is no window in
 * which a changed tool is still approved, and no join to get wrong.
 */
import type { McpBindingId, McpCapabilityId, McpServerId, UserId, WorkspaceId } from '../ids';
import type { JsonSchema } from './model';

export type McpTransport = 'streamable_http' | 'stdio';
export type McpAuthMode = 'none' | 'oauth2' | 'header' | 'passthrough';

/** Determines approval defaults and whether server-supplied hints are trusted at all. */
export type TrustTier = 'first_party' | 'verified' | 'community' | 'untrusted';

export const TRUST_RANK: Readonly<Record<TrustTier, number>> = Object.freeze({
  untrusted: 0, community: 1, verified: 2, first_party: 3,
});

export type CapabilityKind = 'tool' | 'resource' | 'resource_template' | 'prompt';

/** Spec `cacheScope`. Absent or unrecognised is treated as per-user: fail closed. */
export type CacheScope = 'user' | 'session' | 'shared' | 'unknown';

export interface McpServer {
  readonly id: McpServerId;
  /** undefined = platform catalog entry, shared across workspaces. */
  readonly workspaceId?: WorkspaceId;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly transport: McpTransport;
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly authMode: McpAuthMode;
  readonly authConfig?: Readonly<Record<string, unknown>>;
  readonly trustTier: TrustTier;
  readonly protocolVersionPin?: string;
  readonly publisher?: string;
}

/** A workspace's installation of a server. Agents attach to bindings, not servers. */
export interface McpServerBinding {
  readonly id: McpBindingId;
  readonly workspaceId: WorkspaceId;
  readonly mcpServerId: McpServerId;
  /** Unique per workspace — makes canonical tool names collision-free by construction. */
  readonly alias: string;
  readonly credentialId?: string;
  readonly perUserAuth: boolean;
  readonly status: 'pending_auth' | 'connected' | 'error' | 'disabled';
  readonly negotiatedProtocolVersion?: string;
  readonly discovery?: {
    readonly lastAt: Date;
    readonly ttlMs?: number;
    readonly cacheScope: CacheScope;
    readonly capabilityCount: number;
  };
  readonly health: {
    readonly lastOkAt?: Date;
    readonly consecutiveFailures: number;
    readonly circuitState: 'closed' | 'open' | 'half_open';
    readonly lastError?: string;
  };
  readonly enabled: boolean;
}

export type ApprovalState = 'pending' | 'approved' | 'revoked';

export interface CapabilityApproval {
  readonly state: ApprovalState;
  /** Compared against the capability's current definitionHash. */
  readonly definitionHash: string;
  readonly approvedBy?: UserId;
  readonly approvedAt?: Date;
}

export interface McpCapability {
  readonly id: McpCapabilityId;
  readonly workspaceId: WorkspaceId;
  readonly bindingId: McpBindingId;
  /** 'workspace' or `user:<id>` — part of every cache key. */
  readonly scopeKey: string;
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly canonicalName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly definitionHash: string;
  readonly approval: CapabilityApproval;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly removedAt?: Date;
}

/**
 * The rug-pull defence, stated once.
 *
 * A server can change a tool's schema or description after approval, and the
 * description enters the model's context — so this is an injection surface as
 * well as a capability change.
 */
export const isCapabilityUsable = (cap: McpCapability): boolean =>
  cap.removedAt === undefined &&
  cap.approval.state === 'approved' &&
  cap.approval.definitionHash === cap.definitionHash;

export const capabilityBlockReason = (
  cap: McpCapability,
): 'removed' | 'not_approved' | 'capability_changed' | undefined => {
  if (cap.removedAt !== undefined) return 'removed';
  if (cap.approval.state !== 'approved') return 'not_approved';
  if (cap.approval.definitionHash !== cap.definitionHash) return 'capability_changed';
  return undefined;
};

/** Canonical namespacing: `<alias>__<tool>`. */
export const canonicalCapabilityName = (alias: string, name: string): string => `${alias}__${name}`;

export function splitCanonicalName(canonical: string): { alias: string; name: string } | undefined {
  const i = canonical.indexOf('__');
  if (i <= 0 || i + 2 >= canonical.length) return undefined;
  return { alias: canonical.slice(0, i), name: canonical.slice(i + 2) };
}
