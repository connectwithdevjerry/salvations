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
import { createAssistantSource } from '@/lib/assistant-server';

export const runtime = 'nodejs';
/** `ask` waits for a run; give it room. */
export const maxDuration = 120;

type Params = { params: Promise<{ workspaceId: string; agentId: string }> };

async function serve(request: Request, context: Params): Promise<Response> {
  const { workspaceId, agentId } = await context.params;

  try {
    const { principal } = await resolvePrincipal(request, workspaceId);
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
      // Tells an MCP client it must present credentials, in the form the
      // spec expects. Ours are keys, not OAuth, so there is no resource
      // metadata to point at — the challenge is the plain form.
      if (status === 401) response.headers.set('www-authenticate', 'Bearer realm="hive"');
      return response;
    }
    console.error('[assistant mcp]', error);
    return jsonError(500, 'internal', 'Something went wrong.');
  }
}

const jsonError = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status });

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
