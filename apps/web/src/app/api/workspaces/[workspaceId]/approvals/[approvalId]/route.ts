/**
 * Answering an approval.
 *
 * Deciding does two things that must both happen: it records the decision, and
 * it puts the run back in the queue. A decision that did not requeue would sit
 * answered and idle until the sweeper noticed, which is the kind of bug that
 * looks like "the agent ignored me".
 */
import { decideApprovalSchema } from '@salvations/contracts';
import { asId, type RunId } from '@salvations/core';
import { MongoRunQueue } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { VercelBackgroundTrigger } from '@/lib/trigger';

export const runtime = 'nodejs';

export const POST = workspaceRoute<{ approvalId: string }>(
  'approvals:decide',
  async (ctx, params) => {
    const input = await jsonBody(ctx.request, decideApprovalSchema);

    const approval = await ctx.repos.runs.findApproval(params.approvalId);
    if (approval === null) return errorResponse(404, 'not_found', 'Approval not found.');
    if (approval.decision !== null && approval.decision !== undefined) {
      // Not an error to retry, but not a second decision either: the first
      // answer stands.
      return ok({ id: params.approvalId, decision: approval.decision, alreadyDecided: true });
    }
    if (approval.expiresAt.getTime() < Date.now()) {
      return errorResponse(
        409, 'conflict',
        'This request expired. The run has to be started again.',
      );
    }

    await ctx.repos.runs.decideApproval(
      params.approvalId,
      input.decision,
      actorIdOf(ctx.principal),
      input.response,
    );

    // Back to `queued`, then a wake-up. Order matters: a push that arrived
    // first would find a run still marked as waiting and do nothing.
    await new MongoRunQueue(ctx.database).enqueue(approval.runId);
    await new VercelBackgroundTrigger().trigger(asId<RunId>(approval.runId));

    return ok({ id: params.approvalId, decision: input.decision, runId: approval.runId });
  },
);
