/**
 * The assistant's MCP server, on the wire.
 *
 * One URL per assistant, created with it. Anything that speaks MCP over
 * streamable HTTP connects here with a workspace key and gets the assistant
 * whole: `ask`, its memory, its knowledge, what it is made of.
 *
 * Authentication is ours: a key minted on the assistant's Server tab, sent
 * as a bearer token, resolved to a principal with scopes. No identity vendor
 * sits between a caller and the assistant, and the principal is the one the
 * run acts on behalf of — the same permission checks as the web chat.
 */
import { createAssistantServer, serveOverHttp } from '@salvations/servers';
import { AgentRepository } from '@salvations/db';
import { DomainError, publicMessageOf } from '@salvations/core';
import { db } from '@/lib/db';
import { requirePermission, resolvePrincipal } from '@/lib/principal';
import { bearerChallenge, resolveOAuthPrincipal } from '@/lib/oauth-server';
import { createAssistantSource } from '@/lib/assistant-server';

export const runtime = 'nodejs';
/** `ask` waits for a run; give it room. */
export const maxDuration = 120;

type Params = { params: Promise<{ workspaceId: string; agentId: string }> };

async function serve(request: Request, context: Params): Promise<Response> {
  const { workspaceId, agentId } = await context.params;

  try {
    const principal = await principalFor(request, workspaceId, agentId);
    requirePermission(principal, 'runs:create');

    const handle = await db();
    const agent = await new AgentRepository(handle.db, workspaceId).findById(agentId);
    if (agent === null) return jsonError(404, 'not_found', 'No such assistant.');

    const source = createAssistantSource({
      database: handle.db,
      workspaceId,
      agentId,
      principal,
      name: agent.name,
      description: agent.description === '' || agent.description === undefined
        ? 'An assistant in HIVE.'
        : agent.description,
    });

    return await serveOverHttp(() => createAssistantServer(
      { workspaceId, conversationId: '', agentId, runId: '' },
      source,
    ))(request);
  } catch (error) {
    if (error instanceof DomainError) {
      const status = error.code === 'unauthenticated' ? 401 : error.code === 'not_found' ? 404 : 403;
      const response = jsonError(status, error.code, publicMessageOf(error));
      // Tells an MCP client where to find out how to sign in: the resource
      // metadata names this platform as the authorization server, and a
      // client that follows it ends on the consent page with a HIVE login.
      if (status === 401) response.headers.set('www-authenticate', bearerChallenge(workspaceId, agentId));
      return response;
    }
    console.error('[assistant mcp]', error);
    return jsonError(500, 'internal', 'Something went wrong.');
  }
}

/**
 * Two kinds of bearer: a workspace key minted on the Server tab, or an access
 * token our authorization server issued to a client the person signed into.
 * The prefix says which; each is verified by the code that minted it.
 */
async function principalFor(request: Request, workspaceId: string, agentId: string) {
  const raw = request.headers.get('authorization') ?? '';
  const [scheme, token] = raw.split(' ');
  if (scheme?.toLowerCase() === 'bearer' && token !== undefined) {
    const viaOAuth = await resolveOAuthPrincipal(token, workspaceId, agentId);
    if (viaOAuth !== undefined) return viaOAuth;
  }
  return (await resolvePrincipal(request, workspaceId)).principal;
}

const jsonError = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status });

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
