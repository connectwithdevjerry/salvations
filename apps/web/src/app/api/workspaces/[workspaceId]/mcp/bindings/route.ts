/**
 * Installed MCP servers.
 *
 * Installing one does NOT make its tools callable. Discovery runs, capabilities
 * land as `pending`, and somebody has to approve them — which is the whole
 * point of the approval flow, and why this route returns a binding in
 * `pending_auth` rather than pretending it is ready.
 */
import { installMcpServerSchema } from '@salvations/contracts';
import { ScopedDb, type McpServerBindingDoc } from '@salvations/db';
import { IdPrefix, newId } from '@salvations/core';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { discoverAndRecord } from '@/lib/discovery-service';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

export const GET = workspaceRoute('mcp:read', async (ctx) => {
  const scoped = new ScopedDb(ctx.database, ctx.workspaceId);
  const bindings = await scoped
    .collection<McpServerBindingDoc>('mcpServerBindings')
    .find({} as never);

  const servers = await ctx.database
    .collection('mcpServers')
    .find({ _id: { $in: bindings.map((b) => b.mcpServerId) } } as never)
    .toArray();
  const byId = new Map(servers.map((s) => [String(s['_id']), s]));

  return ok({
    items: bindings.map((b) => {
      const server = byId.get(b.mcpServerId);
      return {
        id: b._id,
        alias: b.alias,
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

  // The alias is unique per workspace, which is what makes canonical tool names
  // collision-free by construction rather than by a runtime check.
  const clash = await bindings.findOne({ alias: input.alias } as never);
  if (clash !== null) {
    return errorResponse(
      409, 'conflict',
      `The alias "${input.alias}" is already used by another server in this workspace.`,
    );
  }

  let mcpServerId = input.mcpServerId;
  if (mcpServerId === undefined) {
    // A workspace-owned server: recorded as untrusted, because nobody has
    // vetted it and a trust tier is a claim somebody has to make.
    mcpServerId = newId(IdPrefix.mcpServer);
    await ctx.database.collection('mcpServers').insertOne({
      _id: mcpServerId,
      workspaceId: ctx.workspaceId,
      slug: input.alias,
      name: input.name ?? input.alias,
      transport: 'streamable_http',
      url: input.url,
      authMode: 'oauth2',
      trustTier: 'untrusted',
      createdAt: new Date(),
    } as never);
  }

  const binding = await bindings.insertOne({
    _id: newId(IdPrefix.mcpBinding),
    mcpServerId,
    alias: input.alias,
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
   * This was the missing step. Installing a server used to write the row and
   * stop, leaving `discovery: null` — so no capability row was ever created,
   * the approval queue had nothing in it, and nothing the server offered could
   * ever be called. A server whose tools never appear looks broken, and the
   * person has no way to tell whether it is their URL, their credentials or us.
   *
   * It runs inline rather than in the background so its outcome is part of the
   * answer: a server needing authorisation says so here, and a server that is
   * simply unreachable says that instead of silently looking installed.
   */
  const discovered = await discoverAndRecord({
    database: ctx.database,
    workspaceId: ctx.workspaceId,
    definition: {
      bindingId: binding._id,
      serverId: mcpServerId,
      alias: binding.alias,
      transport: 'streamable_http',
      ...(input.url !== undefined ? { url: input.url } : {}),
    },
    // Never for a server somebody just pasted a URL for. Its tool descriptions
    // reach the model, so a human reads them first.
    autoApprove: false,
    ...(input.perUserAuth ? { userId: actorIdOf(ctx.principal) } : {}),
  });

  return ok({
    id: binding._id,
    alias: binding.alias,
    status: binding.status,
    capabilities: discovered.total,
    ...(discovered.error !== undefined ? { discoveryError: discovered.error } : {}),
  }, 201);
});
