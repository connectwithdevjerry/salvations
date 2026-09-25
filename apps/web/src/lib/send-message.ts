/**
 * Saying something to a conversation.
 *
 * One path for a typed message and a spoken one. Sending does NOT execute
 * anything inline: it appends the message, creates a queued run, and pushes a
 * wake-up — so the request returns in milliseconds and the answer arrives
 * over the event stream. A handler that waited for the model would hold a
 * connection for the length of an agent loop and lose the answer when it
 * timed out.
 */
import { AgentRepository, type AgentDoc } from '@salvations/db';
import {
  DEFAULT_BUDGET, Errors, asId, clampBudget, type Principal, type RunId,
} from '@salvations/core';
import type { WorkspaceContext } from './route';
import { actorIdOf } from './principal';
import { VercelBackgroundTrigger } from './trigger';
import { agentSnapshotFor } from './agent-snapshot';

export interface SendInput {
  readonly content: string;
  /** Continue the same conversation on a different model. */
  readonly modelBindingId?: string | undefined;
  readonly budget?: Parameters<typeof clampBudget>[0];
  readonly idempotencyKey?: string | undefined;
}

export interface SendOutcome {
  readonly runId: string;
  readonly status: string;
  readonly modelBindingId: string;
}

export async function sendUserMessage(
  ctx: Pick<WorkspaceContext, 'database' | 'workspaceId' | 'repos' | 'principal'>,
  conversationId: string,
  input: SendInput,
): Promise<SendOutcome> {
  const conversation = await ctx.repos.conversations.findById(conversationId);
  if (conversation === null) throw Errors.notFound('Conversation not found.');

  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(conversation.agentId);
  if (agent === null) throw Errors.conflict('This conversation has no agent.');

  // Switching model mid-conversation is a normal operation, not a migration:
  // history is canonical and artifacts are keyed by the model that made them,
  // so the next turn simply drops what it cannot replay (AC-2).
  if (input.modelBindingId !== undefined && input.modelBindingId !== conversation.modelBindingId) {
    const binding = await ctx.repos.models.findById(input.modelBindingId);
    if (binding === null) throw Errors.notFound('Model binding not found.');
    await ctx.repos.conversations.setModelBinding(conversationId, input.modelBindingId);
  }

  const modelBindingId = await usableModel(ctx, conversationId, input.modelBindingId, conversation.modelBindingId, agent);

  await ctx.repos.conversations.appendMessage({
    conversationId,
    role: 'user',
    content: [{ type: 'text', text: input.content }],
    // Present, the message id is derived from it, so a retried submission
    // collides on _id instead of appending a duplicate.
    ...(input.idempotencyKey !== undefined ? { clientMessageId: input.idempotencyKey } : {}),
  });

  const run = await ctx.repos.runs.create({
    conversationId,
    agentId: conversation.agentId,
    agentVersionId: agent.currentVersion.versionId,
    // PINNED. An edit to the agent after this point cannot change what this
    // run does.
    agentSnapshot: await agentSnapshotFor(ctx.database, ctx.workspaceId, conversation.agentId, agent.currentVersion),
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

  return { runId: run._id, status: run.status, modelBindingId };
}

/**
 * The run acts as the AGENT, on behalf of the caller.
 *
 * Delegation rather than impersonation: an agent holds no grants of its own,
 * and its effective authority is the intersection of what it was given and what
 * the person still has.
 */
const delegated = (principal: Principal): Principal => principal;

/**
 * The model this turn runs on.
 *
 * In order: a model the person picked for this conversation in the composer;
 * the model the assistant was given on its Model tab; the binding the
 * conversation started on; and last, whatever serves the assistant's role.
 * Each is checked to still exist and be enabled — a provider taken off the
 * Models page takes its bindings with it — and the conversation is moved to
 * the winner, so the next turn does not have to work it out again.
 */
async function usableModel(
  ctx: Pick<WorkspaceContext, 'repos'>,
  conversationId: string,
  requested: string | undefined,
  pinned: string,
  agent: Pick<AgentDoc, 'modelBindingId' | 'currentVersion'>,
): Promise<string> {
  const usable = async (id: string | null | undefined): Promise<string | undefined> => {
    if (id == null) return undefined;
    const binding = await ctx.repos.models.findById(id);
    return binding !== null && binding.enabled ? binding._id : undefined;
  };

  const winner = await usable(requested)
    ?? await usable(agent.modelBindingId)
    ?? await usable(pinned)
    ?? (await ctx.repos.models.forRole(agent.currentVersion.modelRole))?._id;

  if (winner === undefined) {
    throw Errors.conflict(
      'No model is connected for this assistant. Connect Claude or OpenAI on the Models page and try again.',
    );
  }
  if (winner !== pinned) await ctx.repos.conversations.setModelBinding(conversationId, winner);
  return winner;
}
