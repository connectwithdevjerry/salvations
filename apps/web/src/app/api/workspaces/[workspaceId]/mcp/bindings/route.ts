/**
 * Installed MCP servers.
 *
 * Installing a pasted URL does NOT make its tools callable. Discovery runs,
 * capabilities land as `pending`, and somebody has to approve them — which is
 * the whole point of the approval flow.
 *
 * A CATALOGUE integration is different: the URL is the vendor's own, hard-coded
 * here rather than found in a docs page, the person authorises it on the
 * vendor's consent screen, and every tool it offers is then the agents' to
 * call. That is what "connect GitHub" means to somebody; a second approval
 * queue after the consent screen would be the same question asked twice.
 * What a tool may DO is still policy's decision at call time.
 */
import { installMcpServerSchema } from '@salvations/contracts';
import { catalogEntry } from '@salvations/catalog';
import { AgentRepository, ScopedDb, type McpServerBindingDoc } from '@salvations/db';
import { mcpServersById } from '@/lib/mcp-servers';
import { IdPrefix, newId } from '@salvations/core';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { discoverAndRecord } from '@/lib/discovery-service';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

export const GET = workspaceRoute('mcp:read', async (ctx) => {
  const scoped = new ScopedDb(ctx.database, ctx.workspaceId);
  // `?agent=` narrows to one assistant's connections, plus any written before
  // connections belonged to an assistant, which every assistant still sees.
  const agent = new URL(ctx.request.url).searchParams.get('agent');
  const bindings = await scoped
    .collection<McpServerBindingDoc>('mcpServerBindings')
    .find((agent === null
      ? {}
      : { $or: [{ agentId: agent }, { agentId: null }, { agentId: { $exists: false } }] }) as never);

  const byId = await mcpServersById(ctx.database, ctx.workspaceId, bindings.map((b) => b.mcpServerId));

  return ok({
    items: bindings.map((b) => {
      const server = byId.get(b.mcpServerId);
      return {
        id: b._id,
        agentId: b.agentId ?? undefined,
        alias: b.alias,
        catalogId: typeof server?.catalogId === 'string' ? server.catalogId : undefined,
        serverName: String(server?.['name'] ?? b.alias),
        url: server?.['url'] ?? undefined,
        trustTier: String(server?.['trustTier'] ?? 'untrusted'),
        status: b.status,
        perUserAuth: b.perUserAuth,
        negotiatedProtocolVersion: b.negotiatedProtocolVersion ?? undefined,
        capabilityCount: b.discovery?.capabilityCount ?? 0,
        health: {
          circuitState: b.health.circuitState,
          consecutiveFailures: b.health.consecutiveFailures,
          lastOkAt: b.health.lastOkAt?.toISOString(),
          lastError: b.health.lastError ?? undefined,
        },
      };
    }),
  });
});

export const POST = workspaceRoute('mcp:install', async (ctx) => {
  const input = await jsonBody(ctx.request, installMcpServerSchema);
  const scoped = new ScopedDb(ctx.database, ctx.workspaceId);
  const bindings = scoped.collection<McpServerBindingDoc>('mcpServerBindings');

  const entry = input.catalogId === undefined ? undefined : catalogEntry(input.catalogId);
  if (input.catalogId !== undefined && (entry === undefined || entry.kind !== 'integration')) {
    return errorResponse(422, 'validation_failed', `There is no "${input.catalogId}" integration.`);
  }
  if (entry !== undefined && entry.unavailable !== undefined) {
    return errorResponse(422, 'unsupported', `${entry.name} cannot be connected yet. ${entry.unavailable}`);
  }
  if (entry !== undefined && entry.mcp === undefined && entry.native === undefined) {
    return errorResponse(422, 'unsupported', `${entry.name} is not reached over MCP.`);
  }

  // A native entry is served by an adapter of ours in this process; its
  // alias is fixed so the opener knows which adapter to build.
  const alias = entry?.native?.alias ?? input.alias ?? entry?.id ?? '';
  const url = entry?.mcp?.url ?? input.url;

  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(input.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'Assistant not found.');

  // The alias is unique per assistant, which is what makes its canonical tool
  // names collision-free by construction rather than by a runtime check.
  const clash = await bindings.findOne({ agentId: input.agentId, alias } as never);
  if (clash !== null) {
    return errorResponse(
      409, 'conflict',
      entry !== undefined
        ? `${entry.name} is already connected to ${agent.name}.`
        : `${agent.name} already has a server aliased "${alias}".`,
    );
  }

  let mcpServerId = input.mcpServerId;
  if (mcpServerId === undefined) {
    mcpServerId = newId(IdPrefix.mcpServer);
    await ctx.database.collection('mcpServers').insertOne({
      _id: mcpServerId,
      workspaceId: ctx.workspaceId,
      slug: alias,
      name: entry?.name ?? input.name ?? alias,
      transport: entry?.native !== undefined ? 'in_process' : 'streamable_http',
      url: entry?.native !== undefined ? null : url,
      authMode: 'oauth2',
      // A catalogue server is the vendor's own, at a URL we wrote down; a
      // pasted one is untrusted because nobody has vetted it and a trust tier
      // is a claim somebody has to make.
      trustTier: entry !== undefined ? 'verified' : 'untrusted',
      ...(entry !== undefined ? { catalogId: entry.id } : {}),
      createdAt: new Date(),
    } as never);
  }

  const binding = await bindings.insertOne({
    _id: newId(IdPrefix.mcpBinding),
    mcpServerId,
    agentId: input.agentId,
    alias,
    credentialId: null,
    perUserAuth: input.perUserAuth,
    // Nothing is callable yet: consent has not been given and no capability
    // has been approved.
    status: 'pending_auth',
    negotiatedProtocolVersion: null,
    discovery: null,
    health: { consecutiveFailures: 0, circuitState: 'closed' },
    enabled: true,
    createdBy: actorIdOf(ctx.principal),
    createdAt: new Date(),
  } as never);

  /*
   * Discover immediately.
   *
   * It runs inline rather than in the background so its outcome is part of the
   * answer: a server wanting consent answers with the URL to send the person
   * to, and a server that is simply unreachable says that instead of silently
   * looking installed.
   */
  const discovered = await discoverAndRecord({
    database: ctx.database,
    workspaceId: ctx.workspaceId,
    definition: {
      bindingId: binding._id,
      serverId: mcpServerId,
      alias: binding.alias,
      transport: 'streamable_http',
      ...(url !== undefined ? { url } : {}),
    },
    // Only for a catalogue server: the vendor's own, connected by the person
    // on the vendor's consent screen. Never for a pasted URL, whose tool
    // descriptions reach the model and so get read by a human first.
    autoApprove: entry !== undefined,
    ...(input.perUserAuth ? { userId: actorIdOf(ctx.principal) } : {}),
  });

  return ok({
    id: binding._id,
    alias: binding.alias,
    status: discovered.authorizationUrl !== undefined ? 'pending_auth'
      : discovered.error !== undefined ? 'error' : 'connected',
    capabilities: discovered.total,
    ...(discovered.authorizationUrl !== undefined ? { authorizationUrl: discovered.authorizationUrl } : {}),
    ...(discovered.error !== undefined ? { discoveryError: discovered.error } : {}),
  }, 201);
});
