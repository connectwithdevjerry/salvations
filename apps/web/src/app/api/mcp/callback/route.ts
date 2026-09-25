/**
 * Back from the vendor's consent screen.
 *
 * The authorization server sends `code` and `state`. The cookie set when
 * consent began says which connection this is; the state is then checked
 * against the pending record filed under that connection, and the code is
 * redeemed with the PKCE verifier from the same record. Only then is the
 * server asked what it offers.
 *
 * Every failure lands the person back on the integrations page with a reason
 * they can act on, never on a JSON error they cannot.
 */
import { completeAuthorization, scopeKeyString, userScope, workspaceScope, type ConnectionScopeKey } from '@salvations/mcp';
import { clearCookie, readCookie } from '@salvations/auth';
import { ScopedDb, type McpServerBindingDoc } from '@salvations/db';
import { mcpServerById } from '@/lib/mcp-servers';
import { db } from '@/lib/db';
import { readCaller, secureCookies } from '@/lib/session';
import { oauthProviderFor, oauthStore } from '@/lib/mcp-auth';
import { discoverAndRecord } from '@/lib/discovery-service';
import { firstPartyOpener } from '@/lib/first-party-open';
import { GOOGLE_ISSUER, exchangeGoogleCode, googleOAuthClient, googleStore } from '@/lib/google-workspace';
import { OAUTH_CALLBACK_PATH, OAUTH_PENDING_COOKIE } from '@/lib/oauth-config';
import { env } from '@/lib/env';
import type { PendingConsent } from '@/app/api/workspaces/[workspaceId]/mcp/bindings/[bindingId]/authorize/route';

export const runtime = 'nodejs';

const back = (
  workspaceId: string | undefined,
  query: Record<string, string>,
  agentId?: string | null,
): Response => {
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');
  // To the assistant whose connection this is; to the assistants list when
  // there is no longer one to go to.
  const path = workspaceId === undefined
    ? '/go'
    : agentId == null ? `/w/${workspaceId}/agents` : `/w/${workspaceId}/agents/${agentId}`;
  const target = new URL(path, `${base}/`);
  if (agentId != null) target.searchParams.set('tab', 'integrations');
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  const response = Response.redirect(target.toString(), 303);
  // The cookie has done its job either way; a stale one would confuse the
  // next attempt.
  const headers = new Headers(response.headers);
  headers.append('set-cookie', clearCookie(OAUTH_PENDING_COOKIE, secureCookies(), OAUTH_CALLBACK_PATH));
  return new Response(null, { status: 303, headers });
};

function readPending(request: Request): PendingConsent | undefined {
  const raw = readCookie(request.headers.get('cookie'), OAUTH_PENDING_COOKIE);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PendingConsent>;
    if (typeof parsed.workspaceId !== 'string' || typeof parsed.bindingId !== 'string') return undefined;
    return {
      workspaceId: parsed.workspaceId,
      bindingId: parsed.bindingId,
      ...(typeof parsed.userId === 'string' ? { userId: parsed.userId } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function GET(request: Request): Promise<Response> {
  const pending = readPending(request);
  if (pending === undefined) return back(undefined, { error: 'mcp_no_pending' });

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const iss = url.searchParams.get('iss') ?? undefined;
  const denied = url.searchParams.get('error');
  if (denied !== null) return back(pending.workspaceId, { error: 'mcp_denied' });
  if (code === null || state === null) return back(pending.workspaceId, { error: 'mcp_incomplete' });

  // The person finishing consent must be the person signed in here. A consent
  // completed in somebody else's browser must not attach to this workspace.
  const caller = readCaller(request);
  if (caller === undefined) return back(pending.workspaceId, { error: 'mcp_signed_out' });
  if (pending.userId !== undefined && pending.userId !== caller.userId) {
    return back(pending.workspaceId, { error: 'mcp_wrong_person' });
  }

  const handle = await db();
  const database = handle.db;
  const bindings = new ScopedDb(database, pending.workspaceId)
    .collection<McpServerBindingDoc>('mcpServerBindings');
  const binding = await bindings.findOne({ _id: pending.bindingId } as never);
  if (binding === null) return back(pending.workspaceId, { error: 'mcp_gone' });

  const server = await mcpServerById(database, pending.workspaceId, binding.mcpServerId);
  const scope = pending.userId === undefined
    ? workspaceScope(pending.workspaceId, binding._id)
    : userScope(pending.workspaceId, binding._id, pending.userId);

  if (server?.transport === 'in_process' && server.catalogId === 'google_workspace') {
    return finishGoogle(request, database, pending, binding, scope, { code, state });
  }

  const serverUrl = server?.url;
  if (typeof serverUrl !== 'string') return back(pending.workspaceId, { error: 'mcp_gone' }, binding.agentId);
  const provider = oauthProviderFor(database, pending.workspaceId, scope);

  try {
    await completeAuthorization(
      provider,
      oauthStore(database, pending.workspaceId),
      serverUrl,
      { code, state, ...(iss !== undefined ? { iss } : {}) },
    );
  } catch (caught) {
    console.error('[mcp callback]', caught instanceof Error ? caught.message : caught);
    return back(pending.workspaceId, { error: 'mcp_failed' }, binding.agentId);
  }

  // Authorised. Now ask what it offers, with the token just stored.
  const outcome = await discoverAndRecord({
    database,
    workspaceId: pending.workspaceId,
    definition: {
      bindingId: binding._id, serverId: binding.mcpServerId, alias: binding.alias,
      transport: 'streamable_http', url: serverUrl,
    },
    autoApprove: typeof server?.catalogId === 'string',
    ...(pending.userId !== undefined ? { userId: pending.userId } : {}),
    refresh: true,
  });

  if (outcome.error !== undefined) {
    return back(pending.workspaceId, { error: 'mcp_discovery', alias: binding.alias }, binding.agentId);
  }
  return back(pending.workspaceId, { connected: binding.alias, tools: String(outcome.total) }, binding.agentId);
}

/**
 * Back from Google. The state must be the one filed when consent began, the
 * code is exchanged with our client secret and the PKCE verifier, and the
 * tokens go into the store under the binding's scope. Then the adapter is
 * opened once to record what it offers, exactly as a remote server would be.
 */
async function finishGoogle(
  request: Request,
  database: Awaited<ReturnType<typeof db>>['db'],
  pending: PendingConsent,
  binding: McpServerBindingDoc,
  scope: ConnectionScopeKey,
  answer: { code: string; state: string },
): Promise<Response> {
  const store = googleStore(database, pending.workspaceId);
  const key = scopeKeyString(scope);
  const filed = await store.loadPending(key);
  if (filed === undefined || filed.state !== answer.state) {
    return back(pending.workspaceId, { error: 'mcp_failed' }, binding.agentId);
  }
  const client = googleOAuthClient();
  if (client === undefined) return back(pending.workspaceId, { error: 'mcp_failed' }, binding.agentId);

  try {
    const tokens = await exchangeGoogleCode(client, answer.code, filed.codeVerifier);
    await store.saveTokens(key, GOOGLE_ISSUER, tokens);
    await store.clearPending(key);
  } catch (caught) {
    console.error('[google callback]', caught instanceof Error ? caught.message : caught);
    return back(pending.workspaceId, { error: 'mcp_failed' }, binding.agentId);
  }

  const outcome = await discoverAndRecord({
    database,
    workspaceId: pending.workspaceId,
    definition: { bindingId: binding._id, serverId: binding.mcpServerId, alias: binding.alias, transport: 'in_process' },
    autoApprove: true,
    ...(pending.userId !== undefined ? { userId: pending.userId } : {}),
    connect: {
      openInProcess: firstPartyOpener({
        database,
        context: { workspaceId: pending.workspaceId, conversationId: '', agentId: binding.agentId ?? '', runId: '' },
        availableTools: async () => [],
        ...(pending.userId !== undefined ? { createdBy: pending.userId } : {}),
      }),
    },
    refresh: true,
  });
  void request;
  if (outcome.error !== undefined) {
    return back(pending.workspaceId, { error: 'mcp_discovery', alias: binding.alias }, binding.agentId);
  }
  return back(pending.workspaceId, { connected: binding.alias, tools: String(outcome.total) }, binding.agentId);
}
