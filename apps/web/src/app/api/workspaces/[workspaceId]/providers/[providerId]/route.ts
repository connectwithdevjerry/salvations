/**
 * One provider: remove it.
 *
 * Its key is revoked and every binding that pointed at it goes with it, so a
 * role never resolves to a provider that is no longer there.
 */
import { errorResponse } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const DELETE = workspaceRoute<{ providerId: string }>('providers:write', async (ctx, params) => {
  const provider = await ctx.repos.models.findProvider(params.providerId);
  if (provider === null) return errorResponse(404, 'not_found', 'No provider with that id.');

  if (provider.credentialId !== null && provider.credentialId !== undefined) {
    await ctx.repos.credentials.revoke(provider.credentialId);
  }
  await ctx.repos.models.removeProvider(provider._id);
  return new Response(null, { status: 204 });
});
