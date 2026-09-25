import { MemoryRepository } from '@salvations/db';
import { errorResponse } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

/** Forgetting closes the memory; the record that it was once believed stays. */
export const DELETE = workspaceRoute<{ agentId: string; entryId: string }>('agents:write', async (ctx, params) => {
  const forgotten = await new MemoryRepository(ctx.database, ctx.workspaceId)
    .forget(params.agentId, params.entryId);
  if (!forgotten) return errorResponse(404, 'not_found', 'There is nothing current with that id.');
  return new Response(null, { status: 204 });
});
