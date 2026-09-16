/**
 * The shape of a workspace-scoped route.
 *
 * Every handler goes through here, which is what makes the three things below
 * unforgettable rather than merely conventional:
 *
 *   1. The caller is resolved to exactly one Principal. There is no ambient
 *      authority and no "current user" global.
 *   2. A permission is checked SERVER-SIDE. The UI hiding a button is a
 *      courtesy; this is the enforcement.
 *   3. Every database handle is workspace-scoped. A handler cannot reach a
 *      collection without saying whose data it wants.
 *
 * A guard that lives at call sites is a guard that is missing from one of them.
 */
import type { Permission, Principal } from '@salvations/core';
import type { Database } from '@salvations/db';
import { db } from './db';
import { errorResponse } from './http';
import { repositories } from './container';
import { requirePermission, resolvePrincipal } from './principal';

export interface WorkspaceContext {
  readonly principal: Principal;
  readonly workspaceId: string;
  readonly database: Database;
  readonly repos: ReturnType<typeof repositories>;
  readonly request: Request;
}

type Params = Record<string, string>;

export function workspaceRoute<P extends Params>(
  permission: Permission,
  handler: (ctx: WorkspaceContext, params: P) => Promise<Response>,
) {
  return async (
    request: Request,
    context: { params: Promise<P & { workspaceId: string }> },
  ): Promise<Response> => {
    try {
      const params = await context.params;
      const { principal } = await resolvePrincipal(request, params.workspaceId);
      requirePermission(principal, permission);

      const handle = await db();
      return await handler(
        {
          principal,
          workspaceId: params.workspaceId,
          database: handle.db,
          repos: repositories(handle.db, params.workspaceId),
          request,
        },
        params,
      );
    } catch (error) {
      return errorResponse.fromUnknown(error);
    }
  };
}

/** A route that needs a signed-in user but no workspace — creating the first one. */
export function userRoute(
  handler: (request: Request, userId: string) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const { auth } = await import('./auth');
      const instance = await auth();
      const session = await instance.api.getSession({ headers: request.headers });
      const userId = session?.user?.id;
      if (userId === undefined) {
        return errorResponse(401, 'unauthenticated', 'Not signed in.');
      }
      return await handler(request, userId);
    } catch (error) {
      return errorResponse.fromUnknown(error);
    }
  };
}
