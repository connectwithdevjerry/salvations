/**
 * Whether this workspace can actually do anything yet.
 *
 * The last onboarding step shows a checklist filling in. Every line here is a
 * real query against real state — there is no timer and nothing is staged. A
 * progress animation that finishes regardless is worse than no animation: it
 * teaches somebody the setup succeeded, and they find out otherwise the first
 * time they ask their agent for something.
 *
 * Each check says what it is waiting for rather than only that it failed, so
 * the checklist doubles as the instructions for finishing.
 */
import { AgentRepository, ChannelRepository } from '@salvations/db';
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
  const agents = await new AgentRepository(ctx.database, ctx.workspaceId).list();
  const agent = agents[0];

  // The role the agent actually asks for, not an assumption that it is 'chat'.
  // Checking the wrong role would report a model as missing when one is bound,
  // or present when it is bound to something the agent never requests.
  const role = agent?.currentVersion.modelRole ?? 'chat';
  const binding = await ctx.repos.models.forRole(role);

  const channels = await new ChannelRepository(ctx.database, ctx.workspaceId).list();
  const connected = channels.filter((c) => c.status === 'connected');

  const approvedTools = await ctx.repos.capabilities.countApproved();

  const checks: Check[] = [
    {
      id: 'agent',
      label: 'Your agent exists',
      ready: agent !== undefined,
      required: true,
      ...(agent === undefined ? { waitingFor: 'Create an agent.' } : {}),
    },
    {
      id: 'model',
      label: 'It has a model to think with',
      ready: binding !== null,
      required: true,
      ...(binding === null
        ? { waitingFor: `Nothing is bound to the "${role}" role yet.` }
        : {}),
    },
    {
      id: 'channel',
      label: 'You can reach it from a chat app',
      ready: connected.length > 0,
      // Optional on purpose: the web chat works without any channel at all.
      required: false,
      ...(connected.length === 0
        ? { waitingFor: 'No chat platform connected. The web chat works regardless.' }
        : {}),
    },
    {
      id: 'tools',
      label: 'It has tools it can use',
      // Approved, not merely discovered. An installed server whose tools nobody
      // has read yet gives the agent nothing it may actually call.
      ready: approvedTools > 0,
      required: false,
      ...(approvedTools === 0
        ? { waitingFor: 'No approved tools yet. Connect an MCP server on the Integrations page.' }
        : {}),
    },
  ];

  return ok({
    checks,
    // Only the required ones gate. A workspace with no MCP server is a working
    // workspace; a workspace with no model is not.
    ready: checks.filter((c) => c.required).every((c) => c.ready),
    agentName: agent?.name,
  });
});
