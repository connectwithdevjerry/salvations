/**
 * Connection and cache scoping.
 *
 * The scope key is part of every cache key, every token lookup, and every
 * pooled resource. Mixing two scopes is the cross-tenant bug (SECURITY.md R4),
 * so it is made structurally impossible by TYPE rather than discouraged by
 * convention — there is no way to build a key without saying whose it is.
 */

export type ConnectionScopeKey =
  | { readonly kind: 'workspace'; readonly bindingId: string; readonly workspaceId: string }
  | {
      readonly kind: 'user';
      readonly bindingId: string;
      readonly workspaceId: string;
      readonly userId: string;
    };

export const workspaceScope = (workspaceId: string, bindingId: string): ConnectionScopeKey =>
  ({ kind: 'workspace', workspaceId, bindingId });

export const userScope = (
  workspaceId: string,
  bindingId: string,
  userId: string,
): ConnectionScopeKey => ({ kind: 'user', workspaceId, bindingId, userId });

/** Stable string form. The workspace is always the first segment. */
export function scopeKeyString(scope: ConnectionScopeKey): string {
  return scope.kind === 'user'
    ? `${scope.workspaceId}|${scope.bindingId}|user:${scope.userId}`
    : `${scope.workspaceId}|${scope.bindingId}|workspace`;
}

/** The value stored on a capability row, identifying whose discovery it was. */
export const capabilityScopeKey = (scope: ConnectionScopeKey): string =>
  scope.kind === 'user' ? `user:${scope.userId}` : 'workspace';

/**
 * Chooses the scope for a binding.
 *
 * A binding configured for per-user auth is ALWAYS user-scoped, because two
 * users behind it see different tools and hold different tokens.
 */
export const scopeFor = (
  workspaceId: string,
  bindingId: string,
  perUserAuth: boolean,
  userId: string | undefined,
): ConnectionScopeKey => {
  if (!perUserAuth) return workspaceScope(workspaceId, bindingId);
  if (userId === undefined) {
    throw new Error(
      `Binding ${bindingId} requires per-user authentication, but no user was supplied. ` +
        'Falling back to a workspace scope would let one user act with another\'s tokens.',
    );
  }
  return userScope(workspaceId, bindingId, userId);
};
