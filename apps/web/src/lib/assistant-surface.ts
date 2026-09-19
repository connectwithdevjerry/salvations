/**
 * What an assistant is made of.
 *
 * The single definition of an assistant's surface — its model, the built-in
 * servers, the integrations connected to it and the tools they provide. The
 * run that answers a chat message, the `capabilities` tool an agent uses to
 * look at itself, and the assistant's own MCP server all read THIS, so there
 * is one answer to "what can this assistant do" rather than three that drift.
 *
 * Imports nothing from the composition root, so the composition root may
 * import it.
 */
import {
  AgentRepository, CapabilityRepository, ModelBindingRepository, ScopedDb,
  type Database, type McpCapabilityDoc, type McpServerBindingDoc,
} from '@salvations/db';
import { firstPartyBindings } from './first-party';
import { mcpServersById } from './mcp-servers';

export interface SurfaceTool { readonly name: string; readonly description: string }

export interface AssistantSurface {
  readonly model: string | undefined;
  /** Every tool the assistant may call, approved, across all its servers. */
  readonly tools: readonly SurfaceTool[];
  readonly integrations: readonly { readonly name: string; readonly alias: string; readonly tools: readonly string[] }[];
}

/** Enabled bindings this assistant reaches: its own, plus pre-assistant rows. */
const ownedBy = (agentId: string) => ({
  enabled: true, $or: [{ agentId }, { agentId: null }, { agentId: { $exists: false } }],
});

export async function assistantSurface(
  database: Database,
  workspaceId: string,
  agentId: string,
  /** Present for a per-user binding's surface. */
  userId?: string,
): Promise<AssistantSurface> {
  const scoped = new ScopedDb(database, workspaceId);
  const agent = await new AgentRepository(database, workspaceId).findById(agentId);
  const binding = agent === null
    ? null
    : await new ModelBindingRepository(database, workspaceId).forRole(agent.currentVersion.modelRole);

  const own = await scoped.collection<McpServerBindingDoc>('mcpServerBindings').find(ownedBy(agentId) as never);
  const servers = await mcpServersById(database, workspaceId, own.map((b) => b.mcpServerId));
  const serverName = new Map([...servers].map(([id, s]) => [id, s.name]));

  const reachable = new Set([
    ...firstPartyBindings(workspaceId).map((b) => b.binding.id),
    ...own.map((b) => b._id),
  ]);
  const scopes = ['workspace', ...(userId === undefined ? [] : [`user:${userId}`])];
  const capabilities = new CapabilityRepository(scoped.collection<McpCapabilityDoc>('mcpCapabilities'));
  const approved = (await capabilities.listForScope(scopes))
    .filter((cap) => cap.approval.state === 'approved' && reachable.has(cap.bindingId));

  return {
    model: binding === null ? undefined : `${binding.displayName} (${binding.modelId})`,
    tools: approved.map((cap) => ({ name: cap.canonicalName, description: cap.description ?? '' })),
    integrations: own.map((b) => ({
      name: serverName.get(b.mcpServerId) || b.alias,
      alias: b.alias,
      tools: approved.filter((cap) => cap.bindingId === b._id).map((cap) => cap.canonicalName),
    })),
  };
}

