import { upsertAgentSchema } from '@salvations/contracts';
import { AgentRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ agentId: string }>('agents:read', async (ctx, params) => {
  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(params.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'Agent not found.');

  return ok({
    id: agent._id,
    name: agent.name,
    description: agent.description === '' ? undefined : agent.description,
    category: agent.category ?? undefined,
    color: agent.color ?? undefined,
    systemPrompt: agent.currentVersion.systemPrompt,
    modelRole: agent.currentVersion.modelRole,
    capabilityBindings: agent.currentVersion.capabilityBindings,
    versionId: agent.currentVersion.versionId,
    version: agent.currentVersion.version,
    updatedAt: agent.updatedAt.toISOString(),
  });
});

/**
 * Editing an agent publishes a new VERSION.
 *
 * The previous one is archived first, so a run that pinned it stays
 * reproducible: an edit never changes behaviour halfway through someone else's
 * conversation.
 */
export const PATCH = workspaceRoute<{ agentId: string }>('agents:write', async (ctx, params) => {
  const input = await jsonBody(ctx.request, upsertAgentSchema);
  const repo = new AgentRepository(ctx.database, ctx.workspaceId);

  const agent = await repo.findById(params.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'Agent not found.');

  await repo.publishVersion(
    ctx.database,
    ctx.workspaceId,
    params.agentId,
    {
      versionId: agent.currentVersion.versionId,
      version: agent.currentVersion.version,
      // Omitted means UNCHANGED, not "reset to the default". This is an edit:
      // a caller that sends only a model role must not silently wipe
      // instructions somebody spent time on.
      systemPrompt: input.systemPrompt ?? agent.currentVersion.systemPrompt,
      modelRole: input.modelRole,
      capabilityBindings: input.capabilityBindings.map((b) => ({ ...b, tools: [...b.tools] })),
      guardrails: input.guardrails ?? agent.currentVersion.guardrails,
    },
    `Edited by ${actorIdOf(ctx.principal)}`,
    actorIdOf(ctx.principal),
  );

  // Name, description, group and colour are not versioned: none of it reaches
  // a run, and a rename should not archive anything.
  await repo.setMeta(params.agentId, {
    name: input.name,
    description: input.description ?? '',
    category: input.category === undefined || input.category === '' ? null : input.category,
    ...(input.color !== undefined ? { color: input.color } : {}),
  });

  const updated = await repo.findById(params.agentId);
  return ok({ id: params.agentId, version: updated?.currentVersion.version ?? 0 });
});
