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
import { MongoRunQueue, PolicyRepository } from '@salvations/db';
import { requirePermission } from '@/lib/principal';
import { rememberAllow } from '@/lib/policy-rules';
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
    // A run that is no longer waiting cannot take an answer: it was overtaken
    // by a newer message, or ended. Waking it would resume into the middle
    // of a later exchange.
    const run = await ctx.repos.runs.findById(approval.runId);
    if (run === null || !run.status.startsWith('waiting_')) {
      return errorResponse(409, 'conflict', 'That run has moved on. Ask the assistant again if you still want this.');
    }

    // Remembered before it is decided: a rule that failed to write should
    // not leave the person believing they will not be asked again.
    if (input.remember !== undefined && input.decision === 'approve' && approval.kind === 'tool_call') {
      requirePermission(ctx.principal, 'policies:write');
      const payload = approval.payload as { bindingId?: string; capabilityName?: string };
      if (typeof payload.bindingId !== 'string' || typeof payload.capabilityName !== 'string') {
        return errorResponse(422, 'invalid', 'This question does not name a tool that a rule could cover.');
      }
      const scope = input.remember === 'agent' ? { type: 'agent' as const, id: run.agentId } : { type: 'workspace' as const };
      const policies = new PolicyRepository(ctx.database, ctx.workspaceId);
      const current = (await policies.get(scope))?.rules ?? [];
      await policies.setRules(scope, rememberAllow(current, payload.bindingId, payload.capabilityName), actorIdOf(ctx.principal));
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
