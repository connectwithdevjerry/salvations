/** What this assistant is made of — the same answer its server and its runs use. */
import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { assistantSurface } from '@/lib/assistant-surface';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ agentId: string }>('agents:read', async (ctx, params) => {
  const surface = await assistantSurface(ctx.database, ctx.workspaceId, params.agentId);
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');
  return ok({
    url: `${base}/mcp/w/${ctx.workspaceId}/assistants/${params.agentId}`,
    ...surface,
  });
});
