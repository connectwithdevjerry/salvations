/**
 * Starting (or restarting) consent for a remote server.
 *
 * Answers with the vendor's consent URL and sets the callback cookie that
 * names this connection. The browser does the navigation: a fetch cannot
 * follow a cross-site redirect into a consent screen, and a server-side
 * redirect from an XHR is just an opaque failure.
 */
import { AuthorizationRequiredError, beginAuthorization, userScope, workspaceScope } from '@salvations/mcp';
import { sessionCookie } from '@salvations/auth';
import { ScopedDb, type McpServerBindingDoc } from '@salvations/db';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { oauthProviderFor } from '@/lib/mcp-auth';
import { discoverAndRecord } from '@/lib/discovery-service';
import { OAUTH_CALLBACK_PATH, OAUTH_PENDING_COOKIE, OAUTH_PENDING_COOKIE_SECONDS } from '@/lib/oauth-config';
import { secureCookies } from '@/lib/session';

export const runtime = 'nodejs';

export interface PendingConsent {
  readonly workspaceId: string;
  readonly bindingId: string;
  /** Present for a per-user binding: whose consent this is. */
  readonly userId?: string;
}

export const POST = workspaceRoute<{ bindingId: string }>('mcp:install', async (ctx, params) => {
  const bindings = new ScopedDb(ctx.database, ctx.workspaceId)
    .collection<McpServerBindingDoc>('mcpServerBindings');
  const binding = await bindings.findOne({ _id: params.bindingId } as never);
  if (binding === null) return errorResponse(404, 'not_found', 'Server not found.');

  const server = await ctx.database.collection('mcpServers')
    .findOne({ _id: binding.mcpServerId } as never);
  const url = server?.['url'];
  if (typeof url !== 'string' || url === '') {
    return errorResponse(422, 'unsupported', 'This server has no URL to authorise against.');
  }

  const userId = binding.perUserAuth ? actorIdOf(ctx.principal) : undefined;
  const scope = userId === undefined
    ? workspaceScope(ctx.workspaceId, binding._id)
    : userScope(ctx.workspaceId, binding._id, userId);
  const provider = oauthProviderFor(ctx.database, ctx.workspaceId, scope);

  let authorizationUrl: string | undefined;
  try {
    const begun = await beginAuthorization(provider, url);
    if (begun.status === 'authorized') {
      // A grant already usable — refreshed, or never expired. Discover with it
      // and report the server connected rather than sending anyone anywhere.
      const outcome = await discoverAndRecord({
        database: ctx.database,
        workspaceId: ctx.workspaceId,
        definition: { bindingId: binding._id, serverId: binding.mcpServerId, alias: binding.alias, transport: 'streamable_http', url },
        autoApprove: typeof server?.['catalogId'] === 'string',
        ...(userId !== undefined ? { userId } : {}),
        refresh: true,
      });
      if (outcome.authorizationUrl === undefined) {
        return ok({ status: outcome.error === undefined ? 'connected' : 'error', capabilities: outcome.total });
      }
      authorizationUrl = outcome.authorizationUrl;
    } else {
      authorizationUrl = begun.authorizationUrl;
    }
  } catch (caught) {
    if (caught instanceof AuthorizationRequiredError) authorizationUrl = caught.authorizationUrl;
    else throw caught;
  }

  if (authorizationUrl === undefined) {
    return errorResponse(502, 'mcp_error', 'The server did not say where to send you for consent.');
  }

  const pending: PendingConsent = {
    workspaceId: ctx.workspaceId,
    bindingId: binding._id,
    ...(userId !== undefined ? { userId } : {}),
  };
  const response = ok({ status: 'pending_auth', authorizationUrl });
  response.headers.append('set-cookie', sessionCookie(
    OAUTH_PENDING_COOKIE,
    Buffer.from(JSON.stringify(pending)).toString('base64url'),
    { maxAgeSeconds: OAUTH_PENDING_COOKIE_SECONDS, secure: secureCookies(), path: OAUTH_CALLBACK_PATH },
  ));
  return response;
});
