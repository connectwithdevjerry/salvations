/**
 * Ask the vendor whether the stored key works, and remember the answer.
 */
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { checkProviderKey } from '@/lib/provider-check';

export const runtime = 'nodejs';

export const POST = workspaceRoute<{ providerId: string }>('providers:write', async (ctx, params) => {
  const provider = await ctx.repos.models.findProvider(params.providerId);
  if (provider === null) return errorResponse(404, 'not_found', 'No provider with that id.');

  const check = await checkProviderKey(provider, ctx.repos.credentials, ctx.repos.models);
  return ok({ id: provider._id, lastCheck: { at: check.at.toISOString(), ok: check.ok, message: check.message ?? undefined } });
});
