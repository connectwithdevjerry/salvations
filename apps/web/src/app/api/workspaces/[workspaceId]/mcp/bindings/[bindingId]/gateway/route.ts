/**
 * Connecting a self-hosted agent gateway: its address and its token.
 *
 * The gateway is asked to list its agents before anything is stored, so a
 * wrong address or a refused token is the answer to this request and not a
 * failure discovered later, mid-conversation. The token goes into the
 * credential store encrypted; the address onto the server row. Then the
 * bridge is opened once to record its tools, the same way every other
 * connection is.
 */
import { z } from 'zod';
import { ScopedDb, type McpServerBindingDoc } from '@salvations/db';
import { mcpServerById } from '@/lib/mcp-servers';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { discoverAndRecord } from '@/lib/discovery-service';
import { firstPartyOpener } from '@/lib/first-party-open';
import { normaliseGatewayUrl, probeGateway } from '@/lib/openclaw';

export const runtime = 'nodejs';

const schema = z.object({
  url: z.string().trim().min(8).max(500),
  token: z.string().trim().min(8).max(500),
});

export const POST = workspaceRoute<{ bindingId: string }>('mcp:install', async (ctx, params) => {
  const input = await jsonBody(ctx.request, schema);
  const bindings = new ScopedDb(ctx.database, ctx.workspaceId).collection<McpServerBindingDoc>('mcpServerBindings');
  const binding = await bindings.findOne({ _id: params.bindingId } as never);
  if (binding === null) return errorResponse(404, 'not_found', 'Connection not found.');
  const server = await mcpServerById(ctx.database, ctx.workspaceId, binding.mcpServerId);
  if (server?.catalogId !== 'openclaw') return errorResponse(422, 'unsupported', 'This connection is not an agent gateway.');

  let url: string;
  let agents: readonly { id: string }[];
  try {
    url = normaliseGatewayUrl(input.url);
    agents = await probeGateway(url, input.token);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'The gateway could not be reached.';
    await bindings.updateOne({ _id: binding._id } as never, { $set: { 'health.lastError': message } } as never);
    return errorResponse(422, 'validation_failed', message);
  }

  const credential = await ctx.repos.credentials.store({
    name: 'Agent gateway token',
    kind: 'api_key',
    plaintext: input.token,
    createdBy: actorIdOf(ctx.principal),
    hint: `••••${input.token.slice(-4)}`,
  });
  await ctx.database.collection('mcpServers').updateOne(
    { _id: binding.mcpServerId, workspaceId: ctx.workspaceId } as never,
    { $set: { url } } as never,
  );
  await bindings.updateOne(
    { _id: binding._id } as never,
    { $set: { credentialId: credential._id, 'health.lastError': null } } as never,
  );

  const outcome = await discoverAndRecord({
    database: ctx.database,
    workspaceId: ctx.workspaceId,
    definition: { bindingId: binding._id, serverId: binding.mcpServerId, alias: binding.alias, transport: 'in_process' },
    autoApprove: true,
    connect: {
      openInProcess: firstPartyOpener({
        database: ctx.database,
        context: { workspaceId: ctx.workspaceId, conversationId: '', agentId: binding.agentId ?? '', runId: '' },
        availableTools: async () => [],
      }),
    },
    refresh: true,
  });
  if (outcome.error !== undefined) return errorResponse(502, 'mcp_error', outcome.error);

  return ok({ status: 'connected', capabilities: outcome.total, agents: agents.map((a) => a.id) });
});
