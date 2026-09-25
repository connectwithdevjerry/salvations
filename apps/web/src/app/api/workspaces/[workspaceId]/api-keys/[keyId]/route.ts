import { ApiKeyRepository } from '@salvations/db';
import { errorResponse } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const DELETE = workspaceRoute<{ keyId: string }>('workspace:manage', async (ctx, params) => {
  const revoked = await new ApiKeyRepository(ctx.database).revoke(ctx.workspaceId, params.keyId);
  if (!revoked) return errorResponse(404, 'not_found', 'No live key with that id.');
  return new Response(null, { status: 204 });
});
