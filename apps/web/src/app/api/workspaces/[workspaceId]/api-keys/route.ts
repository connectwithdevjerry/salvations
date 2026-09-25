/**
 * Keys for reaching the workspace from outside — an assistant's MCP server,
 * or a script.
 *
 * A key can never carry more than the person minting it holds: scopes are
 * checked against the minter's own grants, so a member cannot mint an
 * owner's key for themselves. The secret is shown once, in the response
 * that creates it, and never again.
 */
import { createApiKeySchema } from '@salvations/contracts';
import { ApiKeyRepository } from '@salvations/db';
import { hasPermission, type Permission } from '@salvations/core';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

/** What a key for talking to an assistant's server needs, and nothing more. */
export const ASSISTANT_KEY_SCOPES: readonly Permission[] = [
  'agents:read', 'conversations:read', 'conversations:write', 'runs:create', 'knowledge:read',
];

export const GET = workspaceRoute('workspace:manage', async (ctx) => {
  const keys = await new ApiKeyRepository(ctx.database).listForWorkspace(ctx.workspaceId);
  return ok({
    items: keys.map((k) => ({
      id: k._id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString(),
      revokedAt: k.revokedAt?.toISOString(),
    })),
  });
});

export const POST = workspaceRoute('workspace:manage', async (ctx) => {
  const input = await jsonBody(ctx.request, createApiKeySchema);
  const scopes = (input.scopes ?? ASSISTANT_KEY_SCOPES) as Permission[];

  const beyond = scopes.filter((scope) => !hasPermission(ctx.principal, scope));
  if (beyond.length > 0) {
    return errorResponse(
      403, 'forbidden',
      `A key cannot hold more than you do. You do not have: ${beyond.join(', ')}.`,
    );
  }

  const minted = await new ApiKeyRepository(ctx.database).mint(ctx.workspaceId, {
    name: input.name, scopes, createdBy: actorIdOf(ctx.principal),
  });

  return ok({
    id: minted.id,
    name: input.name,
    prefix: minted.prefix,
    scopes,
    // Once. There is no second read of this value anywhere.
    key: minted.key.expose(),
  }, 201);
});
