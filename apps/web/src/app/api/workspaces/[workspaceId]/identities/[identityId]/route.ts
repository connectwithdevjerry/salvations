/** Cutting the tie between a chat account and this person. Only their own. */
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const DELETE = workspaceRoute<{ identityId: string }>('workspace:read', async (ctx, params) => {
  if (ctx.principal.type !== 'user') return errorResponse(403, 'forbidden', 'Only a signed-in person can unlink a chat account.');
  const identity = await ctx.repos.channels.findIdentityById(params.identityId);
  if (identity === null || identity.userId !== String(ctx.principal.userId)) {
    return errorResponse(404, 'not_found', 'That chat account is not linked to you.');
  }
  await ctx.repos.channels.setIdentityUser(identity._id, null);
  return ok({ unlinked: true });
});
