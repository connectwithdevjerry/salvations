import { upsertAgentSchema } from '@salvations/contracts';
import { DEFAULT_SYSTEM_PROMPT } from '@salvations/catalog';
import { AgentRepository } from '@salvations/db';
import { jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

export const GET = workspaceRoute('agents:read', async (ctx) => {
  const agents = await new AgentRepository(ctx.database, ctx.workspaceId).list();
  return ok({
    items: agents.map((a) => ({
      id: a._id,
      name: a.name,
      description: a.description === '' ? undefined : a.description,
      modelRole: a.currentVersion.modelRole,
      version: a.currentVersion.version,
      updatedAt: a.updatedAt.toISOString(),
    })),
  });
});

export const POST = workspaceRoute('agents:write', async (ctx) => {
  const input = await jsonBody(ctx.request, upsertAgentSchema);
  const repo = new AgentRepository(ctx.database, ctx.workspaceId);

  const agent = await repo.create({
    slug: slugOf(input.name),
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    // Applied HERE rather than injected at run time, so the agent carries its
    // own instructions: visible on the agent page, editable, and versioned like
    // anything else it says. A default living only in the runtime would be a
    // set of instructions nobody could read or change.
    systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    modelRole: input.modelRole,
    createdBy: actorIdOf(ctx.principal),
  });

  return ok({ id: agent._id, name: agent.name, version: 1 }, 201);
});

const slugOf = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
