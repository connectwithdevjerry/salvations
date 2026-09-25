/**
 * The assistants.
 *
 * The list carries what the left panel shows for each: its group, its
 * colour, whether it is the main one, whether it is running right now, and
 * the last thing said in any of its conversations. Computed here from the
 * conversations and runs rather than stored on the agent, so it cannot go
 * stale.
 */
import { upsertAgentSchema } from '@salvations/contracts';
import { defaultSystemPrompt, isCurrentDefaultSystemPrompt, isDefaultSystemPrompt } from '@salvations/catalog';
import { WorkspaceRepository, AgentRepository, type AgentDoc, type ConversationDoc, type RunDoc } from '@salvations/db';
import { jsonBody, ok } from '@/lib/http';
import { workspaceRoute, type WorkspaceContext } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

/** Avatar tints, in the order new assistants take them. */
export const AGENT_COLORS = [
  '#3b82f6', '#14b8a6', '#ef4444', '#f59e0b', '#8b5cf6', '#84cc16', '#06b6d4', '#ec4899',
] as const;

/** A run in any of these states is the agent doing something now. */
/** A run that is being worked on right now, or is about to be. */
const WORKING = new Set(['queued', 'running', 'waiting_tool']);
/** A run stopped until a person answers it. */
const WAITING = new Set(['suspended', 'waiting_input', 'waiting_approval']);

export type AgentStatus = 'working' | 'waiting' | 'failed' | 'idle';

export function presentAgents(
  agents: readonly AgentDoc[],
  conversations: readonly ConversationDoc[],
  runs: readonly RunDoc[],
) {
  const lastByAgent = new Map<string, { preview: string; at: string }>();
  for (const c of conversations) {
    if (c.lastMessage == null) continue;
    const known = lastByAgent.get(c.agentId);
    if (known === undefined || c.lastMessage.at.toISOString() > known.at) {
      lastByAgent.set(c.agentId, { preview: c.lastMessage.preview, at: c.lastMessage.at.toISOString() });
    }
  }

  // Runs arrive newest first, so the first seen per agent is its latest.
  const statusByAgent = new Map<string, AgentStatus>();
  for (const run of runs) {
    if (statusByAgent.has(run.agentId)) continue;
    statusByAgent.set(
      run.agentId,
      WORKING.has(run.status) ? 'working'
        : WAITING.has(run.status) ? 'waiting'
          : run.status === 'failed' ? 'failed' : 'idle',
    );
  }

  // The main assistant is the first one made. Nothing is stored for it, so
  // there is no way for two to claim it.
  const oldest = [...agents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

  return agents.map((a) => ({
    id: a._id,
    name: a.name,
    description: a.description === '' ? undefined : a.description,
    category: a.category ?? undefined,
    color: a.color ?? AGENT_COLORS[0],
    main: a._id === oldest?._id,
    status: statusByAgent.get(a._id) ?? 'idle',
    lastMessage: lastByAgent.get(a._id),
    modelRole: a.currentVersion.modelRole,
    version: a.currentVersion.version,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }));
}

export const GET = workspaceRoute('agents:read', async (ctx) => {
  const repo = new AgentRepository(ctx.database, ctx.workspaceId);
  const agents = await upgradeStaleDefaults(ctx, repo, await repo.list());
  const [conversations, runs] = await Promise.all([
    ctx.repos.conversations.list(200),
    ctx.repos.runs.listRecent(200),
  ]);
  return ok({ items: presentAgents(agents, conversations, runs) });
});

export const POST = workspaceRoute('agents:write', async (ctx) => {
  const input = await jsonBody(ctx.request, upsertAgentSchema);
  const repo = new AgentRepository(ctx.database, ctx.workspaceId);

  const agent = await repo.create({
    slug: slugOf(input.name),
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.category !== undefined && input.category !== '' ? { category: input.category } : {}),
    // Round-robin through the palette, so neighbours in the list differ.
    color: input.color ?? AGENT_COLORS[(await repo.count()) % AGENT_COLORS.length],
    // Applied HERE rather than injected at run time, so the agent carries its
    // own instructions: visible on the agent page, editable, and versioned like
    // anything else it says. A default living only in the runtime would be a
    // set of instructions nobody could read or change.
    systemPrompt: input.systemPrompt ?? defaultSystemPrompt({
      assistantName: input.name,
      businessName: (await new WorkspaceRepository(ctx.database).findById(ctx.workspaceId))?.name,
    }),
    modelRole: input.modelRole,
    createdBy: actorIdOf(ctx.principal),
  });

  return ok({ id: agent._id, name: agent.name, version: 1 }, 201);
});

const slugOf = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';

/**
 * An assistant still on a default — nameless, or an earlier wording — gets
 * today's default, once, as a new version, the first time it is listed. A
 * prompt somebody edited is not a default and is left alone.
 */
async function upgradeStaleDefaults(
  ctx: Pick<WorkspaceContext, 'database' | 'workspaceId' | 'principal'>,
  repo: AgentRepository,
  agents: AgentDoc[],
): Promise<AgentDoc[]> {
  const stale = agents.filter((a) =>
    isDefaultSystemPrompt(a.currentVersion.systemPrompt) && !isCurrentDefaultSystemPrompt(a.currentVersion.systemPrompt, a.name));
  if (stale.length === 0) return agents;

  const businessName = (await new WorkspaceRepository(ctx.database).findById(ctx.workspaceId))?.name;
  for (const agent of stale) {
    await repo.publishVersion(
      ctx.database, ctx.workspaceId, agent._id,
      { ...agent.currentVersion, systemPrompt: defaultSystemPrompt({ assistantName: agent.name, businessName }) },
      'Default instructions updated',
      actorIdOf(ctx.principal),
    );
  }
  return repo.list();
}
