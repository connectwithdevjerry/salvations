/**
 * Principal resolution.
 *
 * Every request becomes exactly one Principal before any handler runs. There is
 * no ambient authority and no "current user" global: a handler that needs an
 * identity is handed one, or is refused.
 */
import {
  Errors, asId, hasPermission,
  type ApiKeyId, type Permission, type Principal, type UserId, type WorkspaceId,
} from '@salvations/core';
import { ApiKeyRepository, WorkspaceRepository, AUTH_FAILURE_RESPONSE } from '@salvations/db';
import { db } from './db';
import { readCaller } from './session';

export { AUTH_FAILURE_RESPONSE };

export interface ResolvedRequest {
  readonly principal: Principal;
  readonly workspaceId: WorkspaceId;
}

const bearerOf = (headers: Headers): string | undefined => {
  const raw = headers.get('authorization');
  if (raw === null) return undefined;
  const [scheme, token] = raw.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token !== undefined ? token : undefined;
};

/**
 * Resolves the caller for a workspace-scoped request.
 *
 * An API key carries its own workspace, so a key presented for a different
 * workspace is refused rather than silently retargeted. A session must be an
 * ACTIVE member of the requested workspace — membership is re-checked on every
 * request, so revocation takes effect immediately.
 */
export async function resolvePrincipal(
  request: Request,
  workspaceId: string,
): Promise<ResolvedRequest> {
  const handle = await db();

  const token = bearerOf(request.headers);
  if (token !== undefined) {
    const result = await new ApiKeyRepository(handle.db).resolve(token);
    if (!result.ok) throw Errors.unauthenticated(AUTH_FAILURE_RESPONSE.message);
    if (result.key.workspaceId !== workspaceId) {
      // Not "forbidden": distinguishing would confirm the workspace exists.
      throw Errors.unauthenticated(AUTH_FAILURE_RESPONSE.message);
    }
    return {
      principal: {
        type: 'api_key',
        apiKeyId: asId<ApiKeyId>(result.key.apiKeyId),
        workspaceId: asId<WorkspaceId>(workspaceId),
        scopes: result.key.scopes,
      },
      workspaceId: asId<WorkspaceId>(workspaceId),
    };
  }

  const caller = readCaller(request);
  if (caller === undefined) throw Errors.unauthenticated('Not signed in.');
  const userId = caller.userId;

  const membership = await new WorkspaceRepository(handle.db).membershipOf(workspaceId, userId);
  if (membership === null) {
    // A non-member gets the same answer as a non-existent workspace, so
    // workspace ids are not enumerable by a signed-in stranger.
    throw Errors.notFound('Workspace not found.');
  }

  return {
    principal: {
      type: 'user',
      userId: asId<UserId>(userId),
      workspaceId: asId<WorkspaceId>(workspaceId),
      role: membership.role,
    },
    workspaceId: asId<WorkspaceId>(workspaceId),
  };
}

/**
 * Server-side permission check.
 *
 * The UI hides what a user cannot do as a courtesy; this is the enforcement.
 */
export function requirePermission(principal: Principal, permission: Permission): void {
  if (!hasPermission(principal, permission)) {
    throw Errors.forbidden(`Missing permission: ${permission}`);
  }
}

/**
 * A principal's own id, for attribution.
 *
 * One function rather than a ternary at each call site: an attribution that
 * silently records 'system' for a real user is the kind of thing nobody notices
 * until an audit needs it.
 */
export function actorIdOf(principal: Principal): string {
  switch (principal.type) {
    case 'user': return String(principal.userId);
    case 'api_key': return String(principal.apiKeyId);
    case 'channel_identity': return principal.identityId;
    // An agent acts on someone's behalf and holds no authority of its own, so
    // the attribution follows the delegation rather than stopping at the agent.
    case 'agent': return actorIdOf(principal.onBehalfOf);
    case 'system': return `system:${principal.reason}`;
  }
}
