/**
 * This person's chat accounts in this workspace, and a code to add one.
 *
 * GET lists the platform identities tied to the signed-in person here.
 * POST issues a code for them to send in a chat; the code is theirs, and
 * the chat it is sent to has to be in a workspace they belong to.
 */
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { issueLinkCode, LINK_CODE_TTL_MS } from '@/lib/chat-link';

export const runtime = 'nodejs';

export const GET = workspaceRoute('workspace:read', async (ctx) => {
  if (ctx.principal.type !== 'user') return ok({ items: [] });
  const rows = await ctx.repos.channels.listIdentitiesForUser(String(ctx.principal.userId));
  const channels = await ctx.repos.channels.list();
  const typeOf = new Map(channels.map((c) => [c._id, c.type]));
  return ok({
    items: rows.map((row) => ({
      id: row._id,
      channelId: row.channelId,
      channel: typeOf.get(row.channelId) ?? 'chat',
      label: row.label,
      lastSeenAt: row.lastSeenAt.toISOString(),
    })),
  });
});

export const POST = workspaceRoute('workspace:read', async (ctx) => {
  if (ctx.principal.type !== 'user') {
    return errorResponse(422, 'validation_failed', 'Only a signed-in person can link a chat account.');
  }
  const issued = await issueLinkCode(ctx.database, String(ctx.principal.userId));
  return ok({ code: issued.code, expiresAt: issued.expiresAt.toISOString(), ttlMs: LINK_CODE_TTL_MS }, 201);
});
