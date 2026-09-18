/**
 * Whether an agent can actually do anything yet.
 *
 * The last step of creating an agent shows its server coming together — the
 * memory, the knowledge, the context, the tools, the model. Every line here is
 * a real query against real state; there is no timer and nothing is staged. A
 * progress animation that finishes regardless is worse than no animation: it
 * teaches somebody the setup succeeded, and they find out otherwise the first
 * time they ask their agent for something.
 *
 * Each check says what it is waiting for rather than only that it failed, so
 * the checklist doubles as the instructions for finishing.
 */
import { AgentRepository, ChannelRepository, KnowledgeRepository, ScopedDb, type McpServerBindingDoc } from '@salvations/db';
import { firstPartyBindings } from '@/lib/first-party';
import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

interface Check {
  readonly id: string;
  readonly label: string;
  readonly ready: boolean;
  /** Present only when it is not ready, and always actionable. */
  readonly waitingFor?: string;
  /** False for anything the agent can work without. */
  readonly required: boolean;
}

export const GET = workspaceRoute('workspace:read', async (ctx) => {
  const agents = new AgentRepository(ctx.database, ctx.workspaceId);
  const requested = new URL(ctx.request.url).searchParams.get('agent');
  const agent = requested === null
    ? (await agents.list())[0]
    : (await agents.findById(requested)) ?? undefined;

  // The role the agent actually asks for, not an assumption that it is 'chat'.
  const role = agent?.currentVersion.modelRole ?? 'chat';
  const binding = await ctx.repos.models.forRole(role);

  const channels = await new ChannelRepository(ctx.database, ctx.workspaceId).list();
  const connected = channels.filter((c) => c.status === 'connected' && (agent === undefined || c.agentId === agent._id));

  const documents = (await new KnowledgeRepository(ctx.database, ctx.workspaceId).list())
    .filter((d) => d.status === 'ready').length;

  // This assistant's connections plus the first-party servers — the tools it
  // can actually reach, not everything anybody in the workspace connected.
  const own = agent === undefined ? [] : await new ScopedDb(ctx.database, ctx.workspaceId)
    .collection<McpServerBindingDoc>('mcpServerBindings')
    .find({ enabled: true, $or: [{ agentId: agent._id }, { agentId: null }, { agentId: { $exists: false } }] } as never);
  const approvedTools = await ctx.repos.capabilities.countApprovedFor([
    ...firstPartyBindings(ctx.workspaceId).map((b) => b.binding.id),
    ...own.map((b) => b._id),
  ]);

  const checks: Check[] = [
    {
      id: 'agent',
      label: 'Agent',
      ready: agent !== undefined,
      required: true,
      ...(agent === undefined ? { waitingFor: 'Create an agent.' } : {}),
    },
    {
      id: 'model',
      label: 'Model to think with',
      ready: binding !== null,
      required: true,
      ...(binding === null
        ? { waitingFor: `Nothing is bound to the "${role}" role yet. Connect Claude or OpenAI.` }
        : {}),
    },
    {
      // Exists the moment the agent does: memory is per agent and needs no setup.
      id: 'memory',
      label: 'Memory',
      ready: agent !== undefined,
      required: true,
      ...(agent === undefined ? { waitingFor: 'Comes with the agent.' } : {}),
    },
    {
      id: 'context',
      label: 'Conversation context',
      ready: agent !== undefined,
      required: true,
      ...(agent === undefined ? { waitingFor: 'Comes with the agent.' } : {}),
    },
    {
      id: 'knowledge',
      label: documents === 0
        ? 'Knowledge'
        : `Knowledge — ${documents} ${documents === 1 ? 'document' : 'documents'}`,
      ready: documents > 0,
      // The agent works without it; it just answers from general knowledge.
      required: false,
      ...(documents === 0
        ? { waitingFor: 'Nothing uploaded yet. Add documents on the Knowledge page.' }
        : {}),
    },
    {
      id: 'tools',
      label: approvedTools === 0
        ? 'Tools'
        : `Tools — ${approvedTools} available`,
      // Approved, not merely discovered. An installed server whose tools nobody
      // has read yet gives the agent nothing it may actually call.
      ready: approvedTools > 0,
      required: false,
      ...(approvedTools === 0
        ? { waitingFor: 'No integrations connected yet. Connect one on its Integrations tab.' }
        : {}),
    },
    {
      id: 'channel',
      label: connected.length === 0 ? 'Chat app' : `Chat app — ${connected.map((c) => c.identity.handle).join(', ')}`,
      ready: connected.length > 0,
      // Optional on purpose: the web chat works without any channel at all.
      required: false,
      ...(connected.length === 0
        ? { waitingFor: 'No chat platform connected. The web chat works regardless.' }
        : {}),
    },
  ];

  return ok({
    checks,
    // Only the required ones gate. A workspace with no integration is a
    // working workspace; a workspace with no model is not.
    ready: checks.filter((c) => c.required).every((c) => c.ready),
    agentName: agent?.name,
  });
});
