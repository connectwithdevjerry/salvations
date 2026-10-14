/**
 * Disconnecting an integration.
 *
 * Everything the connection left behind goes with it: the tokens the vendor
 * issued (revoked at the vendor where it offers a way), every person's row
 * for a per-user binding, the tools discovery recorded, the gateway token if
 * there was one, and the server row once no other assistant uses it. An
 * assistant that asks for the tool afterwards finds it gone, not disabled,
 * which is what "disconnect" should mean.
 */
import { AuditRepository, ScopedDb, type McpCapabilityDoc, type McpServerBindingDoc, type OAuthConnectionDoc } from '@salvations/db';
import { mcpServerById } from '@/lib/mcp-servers';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { revokeGoogleTokens } from '@/lib/google-workspace';

export const runtime = 'nodejs';

export const DELETE = workspaceRoute<{ bindingId: string }>('mcp:install', async (ctx, params) => {
  const scoped = new ScopedDb(ctx.database, ctx.workspaceId);
  const bindings = scoped.collection<McpServerBindingDoc>('mcpServerBindings');
  const binding = await bindings.findOne({ _id: params.bindingId } as never);
  if (binding === null) return errorResponse(404, 'not_found', 'Connection not found.');

  const server = await mcpServerById(ctx.database, ctx.workspaceId, binding.mcpServerId);

  // Tokens first, while the rows that name them still exist. Revocation at
  // the vendor is best effort: a vendor that is down must not keep a
  // connection alive here.
  const connections = scoped.collection<OAuthConnectionDoc>('oauthConnections');
  const rows = await connections.find({ bindingId: binding._id } as never);
  let revoked = 0;
  if (server?.catalogId === 'google_workspace') {
    for (const row of rows) {
      try {
        if (await revokeGoogleTokens(ctx.database, ctx.workspaceId, row.scopeKey)) revoked += 1;
      } catch {
        // Already revoked, or Google unreachable: the row goes either way.
      }
    }
  }
  await connections.deleteMany({ bindingId: binding._id } as never);
  await scoped.collection<McpCapabilityDoc>('mcpCapabilities').deleteMany({ bindingId: binding._id } as never);
  if (binding.credentialId !== null && binding.credentialId !== undefined) {
    await ctx.repos.credentials.revoke(binding.credentialId);
  }
  await bindings.deleteOne({ _id: binding._id } as never);

  // The server row describes the vendor, not the connection; it stays while
  // another assistant still points at it.
  const others = await bindings.countDocuments({ mcpServerId: binding.mcpServerId } as never);
  if (others === 0) {
    await ctx.database.collection('mcpServers').deleteOne({ _id: binding.mcpServerId, workspaceId: ctx.workspaceId } as never);
  }

  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: 'user', id: actorIdOf(ctx.principal) },
    action: 'mcp.binding.disconnected',
    subject: { type: 'mcpBinding', id: binding._id },
    metadata: {
      alias: binding.alias,
      agentId: binding.agentId ?? null,
      catalogId: server?.catalogId ?? null,
      connections: rows.length,
      revokedAtVendor: revoked,
      serverRemoved: others === 0,
    },
  });

  return ok({ removed: true, revokedAtVendor: revoked });
});
