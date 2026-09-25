import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = workspaceRoute('approvals:decide', async (ctx) => {
  const pending = await ctx.repos.runs.pendingApprovals();
  return ok({
    items: pending.map((a) => ({
      id: a._id,
      runId: a.runId,
      kind: a.kind,
      payload: a.payload,
      requestedAt: a.requestedAt.toISOString(),
      expiresAt: a.expiresAt.toISOString(),
    })),
  });
});
