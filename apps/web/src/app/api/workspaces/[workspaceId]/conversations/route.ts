import { createConversationSchema } from '@salvations/contracts';
import { AgentRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = workspaceRoute('conversations:read', async (ctx) => {
  const items = await ctx.repos.conversations.list();
  return ok({
    items: items.map((c) => ({
      id: c._id,
      agentId: c.agentId,
      title: c.title ?? 'Untitled',
      modelBindingId: c.modelBindingId,
      messageCount: c.messageCount,
      updatedAt: c.updatedAt.toISOString(),
      lastMessage: c.lastMessage ?? undefined,
    })),
  });
});

export const POST = workspaceRoute('conversations:write', async (ctx) => {
  const input = await jsonBody(ctx.request, createConversationSchema);

  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(input.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'Agent not found.');

  // The agent names a ROLE; the conversation pins the binding that role
  // resolved to, so a later change to the workspace default does not silently
  // move an existing conversation onto a different model.
  const binding = input.modelBindingId !== undefined
    ? await ctx.repos.models.findById(input.modelBindingId)
    : await ctx.repos.models.forRole(agent.currentVersion.modelRole);

  if (binding === null) {
    return errorResponse(
      409, 'conflict',
      `No model is configured for the "${agent.currentVersion.modelRole}" role. ` +
        'Add a model binding before starting a conversation.',
    );
  }

  const conversation = await ctx.repos.conversations.create({
    agentId: input.agentId,
    modelBindingId: binding._id,
    ...(input.title !== undefined ? { title: input.title } : {}),
  });

  return ok({
    id: conversation._id,
    agentId: conversation.agentId,
    modelBindingId: conversation.modelBindingId,
    title: conversation.title ?? 'Untitled',
  }, 201);
});
