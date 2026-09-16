import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ runId: string }>('runs:read', async (ctx, params) => {
  const run = await ctx.repos.runs.findById(params.runId);
  if (run === null) return errorResponse(404, 'not_found', 'Run not found.');

  return ok({
    id: run._id,
    conversationId: run.conversationId,
    agentId: run.agentId,
    status: run.status,
    modelBindingId: run.modelBindingId,
    consumed: run.consumed,
    usage: run.usage,
    budget: run.budget,
    attempts: run.attempts,
    error: run.error ?? undefined,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
  });
});

/**
 * Cancels a run.
 *
 * Marks it cancelled rather than trying to interrupt an executor. The executor
 * is somewhere else, possibly mid-tool-call, and the only honest thing a
 * request here can do is make sure it does not continue afterwards.
 */
export const DELETE = workspaceRoute<{ runId: string }>('runs:cancel', async (ctx, params) => {
  const run = await ctx.repos.runs.findById(params.runId);
  if (run === null) return errorResponse(404, 'not_found', 'Run not found.');

  const cancelled = await ctx.repos.runs.cancel(params.runId);
  return ok({ id: params.runId, cancelled });
});
