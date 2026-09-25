/**
 * OAuth for remote MCP servers, assembled.
 *
 * One place builds the provider for a scope, so the install path, the run
 * path and the callback all file credentials under the same key. Two of them
 * disagreeing would be a token saved by one that the other can never find —
 * a connection that is authorised and does not work.
 */
import {
  ScopedOAuthProvider,
  type ConnectOptions, type ConnectionScopeKey, type OAuthCredentialStore,
} from '@salvations/mcp';
import { MongoOAuthCredentialStore, type Database } from '@salvations/db';
import { oauthClientConfig } from './oauth-config';
import { keyProvider } from './singletons';

/** The db store, checked here against the protocol layer's interface by shape. */
export function oauthStore(
  database: Database,
  workspaceId: string,
): OAuthCredentialStore & Pick<MongoOAuthCredentialStore, 'scopeKeyForState'> {
  return new MongoOAuthCredentialStore(database, workspaceId, keyProvider());
}

export function oauthProviderFor(
  database: Database,
  workspaceId: string,
  scope: ConnectionScopeKey,
): ScopedOAuthProvider {
  return new ScopedOAuthProvider(scope, oauthStore(database, workspaceId), oauthClientConfig());
}

/**
 * Connect options that can authenticate any remote binding in the workspace.
 *
 * Every streamable-HTTP connection gets a provider for its own scope. A server
 * that needs no authorisation never triggers it; one that does gets the stored
 * token, or raises AuthorizationRequiredError with the consent URL.
 */
export function mcpConnectOptions(database: Database, workspaceId: string): ConnectOptions {
  return {
    authProviderFor: (definition, scope) =>
      definition.transport === 'streamable_http'
        ? oauthProviderFor(database, workspaceId, scope)
        : undefined,
  };
}
