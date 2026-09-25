/**
 * The parts of an assistant that are not versioned: its name, description,
 * group and colour. Changing them here archives nothing and reaches no run,
 * which is what a rename from the header should be.
 */
import { z } from 'zod';
import { AgentRepository, WorkspaceRepository } from '@salvations/db';
import { defaultSystemPrompt, isDefaultSystemPrompt } from '@salvations/catalog';
import { actorIdOf } from '@/lib/principal';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

const metaSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(40).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const PATCH = workspaceRoute<{ agentId: string }>('agents:write', async (ctx, params) => {
  const input = await jsonBody(ctx.request, metaSchema);
  const repo = new AgentRepository(ctx.database, ctx.workspaceId);
  const agent = await repo.findById(params.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'Assistant not found.');

  // A prompt nobody has written introduces the assistant by name, so a
  // rename regenerates it. A prompt somebody edited is theirs and stays.
  if (input.name !== undefined && input.name !== agent.name && isDefaultSystemPrompt(agent.currentVersion.systemPrompt)) {
    const workspace = await new WorkspaceRepository(ctx.database).findById(ctx.workspaceId);
    await repo.publishVersion(
      ctx.database, ctx.workspaceId, agent._id,
      {
        ...agent.currentVersion,
        systemPrompt: defaultSystemPrompt({ assistantName: input.name, businessName: workspace?.name }),
      },
      `Renamed to ${input.name}`,
      actorIdOf(ctx.principal),
    );
  }

  await repo.setMeta(params.agentId, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.category !== undefined ? { category: input.category === '' ? null : input.category } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
  });
  return ok({ id: params.agentId, ...input });
});
