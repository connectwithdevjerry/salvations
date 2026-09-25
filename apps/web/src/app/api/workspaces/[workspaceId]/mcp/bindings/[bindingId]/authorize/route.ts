/**
 * Starting (or restarting) consent for a remote server.
 *
 * Answers with the vendor's consent URL and sets the callback cookie that
 * names this connection. The browser does the navigation: a fetch cannot
 * follow a cross-site redirect into a consent screen, and a server-side
 * redirect from an XHR is just an opaque failure.
 */
import { AuthorizationRequiredError, beginAuthorization, scopeKeyString, userScope, workspaceScope } from '@salvations/mcp';
import { sessionCookie } from '@salvations/auth';
import { ScopedDb, type McpServerBindingDoc } from '@salvations/db';
import { mcpServerById } from '@/lib/mcp-servers';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { oauthProviderFor } from '@/lib/mcp-auth';
import { beginGoogleConsent, googleOAuthClient, googleStore } from '@/lib/google-workspace';
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

  const server = await mcpServerById(ctx.database, ctx.workspaceId, binding.mcpServerId);
  const userId = binding.perUserAuth ? actorIdOf(ctx.principal) : undefined;
  const scope = userId === undefined
    ? workspaceScope(ctx.workspaceId, binding._id)
    : userScope(ctx.workspaceId, binding._id, userId);

  if (server?.transport === 'in_process' && server.catalogId === 'google_workspace') {
    // Google's consent, with our own client. What to remember until the
    // person is back is filed under the same scope the tokens will use.
    const client = googleOAuthClient();
    if (client === undefined) {
      return errorResponse(503, 'not_configured', 'This deployment has no Google client configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    }
    const begun = beginGoogleConsent(client);
    await googleStore(ctx.database, ctx.workspaceId).savePending(scopeKeyString(scope), {
      state: begun.state, codeVerifier: begun.codeVerifier, authorizationUrl: begun.authorizationUrl, createdAt: Date.now(),
    });
    return withPendingCookie(ok({ status: 'pending_auth', authorizationUrl: begun.authorizationUrl }), {
      workspaceId: ctx.workspaceId, bindingId: binding._id, ...(userId !== undefined ? { userId } : {}),
    });
  }

  const url = server?.url;
  if (typeof url !== 'string' || url === '') {
    return errorResponse(422, 'unsupported', 'This server has no URL to authorise against.');
  }
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
        autoApprove: typeof server?.catalogId === 'string',
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

  return withPendingCookie(ok({ status: 'pending_auth', authorizationUrl }), {
    workspaceId: ctx.workspaceId,
    bindingId: binding._id,
    ...(userId !== undefined ? { userId } : {}),
  });
});

/** The callback cookie that names which connection a returning person belongs to. */
function withPendingCookie(response: Response, pending: PendingConsent): Response {
  response.headers.append('set-cookie', sessionCookie(
    OAUTH_PENDING_COOKIE,
    Buffer.from(JSON.stringify(pending)).toString('base64url'),
    { maxAgeSeconds: OAUTH_PENDING_COOKIE_SECONDS, secure: secureCookies(), path: OAUTH_CALLBACK_PATH },
  ));
  return response;
}
