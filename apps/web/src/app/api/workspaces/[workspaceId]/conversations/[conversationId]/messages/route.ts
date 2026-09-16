/**
 * Reading a conversation, and saying something to it.
 *
 * Sending a message does NOT execute anything inline. It appends the message,
 * creates a queued run, and pushes a wake-up — so the request returns in
 * milliseconds and the answer arrives over the event stream. A handler that
 * waited for the model would hold a connection for the length of an agent loop
 * and lose the whole answer when it timed out.
 */
import { sendMessageSchema } from '@salvations/contracts';
import { AgentRepository, toMessage } from '@salvations/db';
import {
  DEFAULT_BUDGET, asId, clampBudget, type Principal, type RunId,
} from '@salvations/core';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { VercelBackgroundTrigger } from '@/lib/trigger';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ conversationId: string }>(
  'conversations:read',
  async (ctx, params) => {
    const conversation = await ctx.repos.conversations.findById(params.conversationId);
    if (conversation === null) return errorResponse(404, 'not_found', 'Conversation not found.');

    const after = Number(new URL(ctx.request.url).searchParams.get('after') ?? '');
    const docs = Number.isFinite(after)
      ? await ctx.repos.conversations.messagesSince(params.conversationId, after)
      : await ctx.repos.conversations.recentMessages(params.conversationId, 200);

    return ok({
      conversation: {
        id: conversation._id,
        agentId: conversation.agentId,
        modelBindingId: conversation.modelBindingId,
        title: conversation.title ?? 'Untitled',
      },
      items: docs.map(toMessage).map((m) => ({
        id: m.id,
        seq: m.seq,
        role: m.role,
        content: m.content,
        runId: m.runId,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  },
);

export const POST = workspaceRoute<{ conversationId: string }>(
  'runs:create',
  async (ctx, params) => {
    const input = await jsonBody(ctx.request, sendMessageSchema);

    const conversation = await ctx.repos.conversations.findById(params.conversationId);
    if (conversation === null) return errorResponse(404, 'not_found', 'Conversation not found.');

    const agent = await new AgentRepository(ctx.database, ctx.workspaceId)
      .findById(conversation.agentId);
    if (agent === null) return errorResponse(409, 'conflict', 'This conversation has no agent.');

    // Switching model mid-conversation is a normal operation, not a migration:
    // history is canonical and artifacts are keyed by the model that made them,
    // so the next turn simply drops what it cannot replay (AC-2).
    if (input.modelBindingId !== undefined && input.modelBindingId !== conversation.modelBindingId) {
      const binding = await ctx.repos.models.findById(input.modelBindingId);
      if (binding === null) return errorResponse(404, 'not_found', 'Model binding not found.');
      await ctx.repos.conversations.setModelBinding(params.conversationId, input.modelBindingId);
    }

    const modelBindingId = input.modelBindingId ?? conversation.modelBindingId;

    await ctx.repos.conversations.appendMessage({
      conversationId: params.conversationId,
      role: 'user',
      content: [{ type: 'text', text: input.content }],
      // Present, the message id is derived from it, so a retried submission
      // collides on _id instead of appending a duplicate.
      ...(input.idempotencyKey !== undefined ? { clientMessageId: input.idempotencyKey } : {}),
    });

    const run = await ctx.repos.runs.create({
      conversationId: params.conversationId,
      agentId: conversation.agentId,
      agentVersionId: agent.currentVersion.versionId,
      // PINNED. An edit to the agent after this point cannot change what this
      // run does.
      agentSnapshot: agent.currentVersion,
      modelBindingId,
      trigger: { type: 'user', ref: actorIdOf(ctx.principal) },
      principal: delegated(ctx.principal),
      // Clamped server-side against the ceiling. A caller may ask for LESS —
      // a cheap exploratory run — and never for more: a budget a client can
      // raise is not a budget, and a schema bound is still a number the client
      // chose.
      budget: clampBudget(input.budget, DEFAULT_BUDGET),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });

    // Fire-and-forget. If it fails, the run is already queued and the sweeper
    // collects it — losing the run to a failed push would be far worse than
    // the latency.
    await new VercelBackgroundTrigger().trigger(asId<RunId>(run._id));

    return ok({ runId: run._id, status: run.status, modelBindingId }, 202);
  },
);

/**
 * The run acts as the AGENT, on behalf of the caller.
 *
 * Delegation rather than impersonation: an agent holds no grants of its own,
 * and its effective authority is the intersection of what it was given and what
 * the person still has.
 */
const delegated = (principal: Principal): Principal => principal;
