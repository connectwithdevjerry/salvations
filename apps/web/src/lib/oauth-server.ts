/**
 * HIVE as an authorization server for MCP clients.
 *
 * The direction here is the reverse of `mcp-auth.ts`: there HIVE is the
 * client signing into someone else's server; here Claude.ai or ChatGPT is the
 * client signing into an assistant. The person signs in with their HIVE
 * account, consents on a page of ours, and the client gets tokens for one
 * assistant. No identity vendor is involved and nothing leaves the platform.
 *
 * Shapes follow the MCP authorization specification: RFC 9728 protected
 * resource metadata, RFC 8414 server metadata, RFC 7591 registration,
 * RFC 7636 PKCE and RFC 8707 resource indicators.
 */
import { asId, Errors, type Principal, type UserId, type WorkspaceId } from '@salvations/core';
import { OAuthServerRepository, WorkspaceRepository, AUTH_FAILURE_RESPONSE } from '@salvations/db';
import { opaqueTokenKind } from '@salvations/crypto';
import { db } from './db';
import { issuer } from './session';

/** The one scope offered: use this assistant as the signed-in person. */
export const ASSISTANT_SCOPE = 'assistant';

const ASSISTANT_PATH = /^\/mcp\/w\/([A-Za-z0-9_-]+)\/assistants\/([A-Za-z0-9_-]+)$/;

export const assistantResource = (workspaceId: string, agentId: string): string =>
  `${issuer()}/mcp/w/${workspaceId}/assistants/${agentId}`;

/** Which assistant a resource indicator names, or nothing if it is not one of ours. */
export function parseAssistantResource(resource: string): { workspaceId: string; agentId: string } | undefined {
  let url: URL;
  try { url = new URL(resource); } catch { return undefined; }
  if (url.origin !== issuer()) return undefined;
  const match = ASSISTANT_PATH.exec(url.pathname);
  if (match === null) return undefined;
  return { workspaceId: match[1] as string, agentId: match[2] as string };
}

export const protectedResourceMetadataUrl = (workspaceId: string, agentId: string): string =>
  `${issuer()}/.well-known/oauth-protected-resource/mcp/w/${workspaceId}/assistants/${agentId}`;

/** RFC 9728. One document per assistant, because each is its own resource. */
export const protectedResourceMetadata = (workspaceId: string, agentId: string) => ({
  resource: assistantResource(workspaceId, agentId),
  authorization_servers: [issuer()],
  scopes_supported: [ASSISTANT_SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'HIVE assistant',
});

/** RFC 8414. Public clients only, PKCE required, registration open. */
export const authorizationServerMetadata = () => ({
  issuer: issuer(),
  authorization_endpoint: `${issuer()}/oauth/authorize`,
  token_endpoint: `${issuer()}/api/oauth/token`,
  registration_endpoint: `${issuer()}/api/oauth/register`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [ASSISTANT_SCOPE],
  service_documentation: `${issuer()}/`,
});

/** The challenge an assistant answers an unauthenticated MCP request with. */
export const bearerChallenge = (workspaceId: string, agentId: string): string =>
  `Bearer realm="hive", resource_metadata="${protectedResourceMetadataUrl(workspaceId, agentId)}"`;

/**
 * Where a client may be sent back to.
 *
 * HTTPS anywhere, or plain HTTP on the loopback address for a desktop client
 * listening on a local port. Nothing else: an `http://` redirect to a real
 * host would hand the code to whoever is on the wire.
 */
export function isAcceptableRedirectUri(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.hash !== '') return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  // A custom scheme is how a native app receives its redirect.
  return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) && url.protocol !== 'javascript:' && url.protocol !== 'data:';
}

/** Redirect URIs must match a registered one exactly. */
export const redirectUriRegistered = (registered: readonly string[], presented: string): boolean =>
  registered.includes(presented);

/**
 * The principal behind an access token our server issued.
 *
 * A person, acting as themselves, in one workspace, for one assistant. The
 * membership is re-read on every call so leaving the workspace ends the
 * token's usefulness at once, whatever its expiry says.
 */
export async function resolveOAuthPrincipal(
  token: string,
  workspaceId: string,
  agentId: string,
): Promise<Principal | undefined> {
  if (opaqueTokenKind(token) !== 'access') return undefined;
  const handle = await db();
  const access = await new OAuthServerRepository(handle.db).resolveAccessToken(token);
  if (access === null) throw Errors.unauthenticated(AUTH_FAILURE_RESPONSE.message);
  // Issued for another assistant or another workspace: the same refusal as a
  // bad token, so a token cannot be used to probe which assistants exist.
  if (access.workspaceId !== workspaceId || access.agentId !== agentId) {
    throw Errors.unauthenticated(AUTH_FAILURE_RESPONSE.message);
  }
  const membership = await new WorkspaceRepository(handle.db).membershipOf(workspaceId, access.userId);
  if (membership === null) throw Errors.unauthenticated(AUTH_FAILURE_RESPONSE.message);
  return {
    type: 'user',
    userId: asId<UserId>(access.userId),
    workspaceId: asId<WorkspaceId>(workspaceId),
    role: membership.role,
  };
}
