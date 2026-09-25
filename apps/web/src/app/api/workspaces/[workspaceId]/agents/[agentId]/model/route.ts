/**
 * The model one assistant thinks with.
 *
 * GET says what it is now and what it could be: every provider the workspace
 * has connected, with the vendor's verdict on its key, and the catalogue's
 * chat models for each. PUT chooses one; the binding for that provider and
 * model is reused if the workspace already has it and made if not. DELETE
 * goes back to "whatever serves my role".
 */
import { chooseAgentModelSchema } from '@salvations/contracts';
import { AgentRepository } from '@salvations/db';
import { CATALOG_MODELS, modelsFor } from '@salvations/catalog';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { modelForAgent } from '@/lib/agent-model';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ agentId: string }>('workspace:read', async (ctx, params) => {
  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(params.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'Assistant not found.');

  const providers = await ctx.repos.models.listProviders();
  const current = await modelForAgent(ctx.repos.models, agent);
  const currentProvider = current === null ? undefined : providers.find((p) => p._id === current.providerConfigId);

  return ok({
    current: current === null ? undefined : {
      bindingId: current._id,
      providerConfigId: current.providerConfigId,
      providerType: currentProvider?.providerType,
      modelId: current.modelId,
      displayName: current.displayName,
      // True when this is the assistant's own choice rather than the role's default.
      chosen: agent.modelBindingId === current._id,
    },
    providers: providers.filter((p) => p.enabled).map((p) => ({
      id: p._id,
      providerType: p.providerType,
      name: p.name,
      lastCheck: p.lastCheck === null || p.lastCheck === undefined ? undefined : { ok: p.lastCheck.ok },
    })),
    models: CATALOG_MODELS.filter((m) => m.roles.includes('chat')),
  });
});

export const PUT = workspaceRoute<{ agentId: string }>('agents:write', async (ctx, params) => {
  const input = await jsonBody(ctx.request, chooseAgentModelSchema);
  const agents = new AgentRepository(ctx.database, ctx.workspaceId);
  const agent = await agents.findById(params.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'Assistant not found.');

  const provider = (await ctx.repos.models.listProviders()).find((p) => p._id === input.providerConfigId);
  if (provider === undefined) return errorResponse(404, 'not_found', 'That provider is not connected to this workspace.');

  // Only a model the catalogue lists for this vendor — the same rule as
  // connecting a key, for the same reason: an unrecognised id runs on a
  // fallback profile and fails in ways nobody can see.
  const model = modelsFor(provider.providerType).find((m) => m.id === input.modelId && m.roles.includes('chat'));
  if (model === undefined) {
    return errorResponse(422, 'validation_failed', `"${input.modelId}" is not a ${provider.name} chat model this deployment offers.`);
  }

  const existing = (await ctx.repos.models.list())
    .find((b) => b.providerConfigId === provider._id && b.modelId === model.id && b.enabled);
  const binding = existing ?? await ctx.repos.models.createBinding({
    providerConfigId: provider._id,
    modelId: model.id,
    displayName: model.displayName,
    role: 'chat',
    params: {},
    capabilities: null,
    capabilitiesFetchedAt: null,
    cost: {
      inputPerMTok: model.rates?.inputPerMTok ?? 0,
      outputPerMTok: model.rates?.outputPerMTok ?? 0,
    },
    fallbackBindingId: null,
    enabled: true,
  });

  await agents.setMeta(agent._id, { modelBindingId: binding._id });
  return ok({
    bindingId: binding._id,
    providerConfigId: provider._id,
    providerType: provider.providerType,
    modelId: binding.modelId,
    displayName: binding.displayName,
    chosen: true,
  });
});

export const DELETE = workspaceRoute<{ agentId: string }>('agents:write', async (ctx, params) => {
  const agents = new AgentRepository(ctx.database, ctx.workspaceId);
  if (await agents.findById(params.agentId) === null) return errorResponse(404, 'not_found', 'Assistant not found.');
  await agents.setMeta(params.agentId, { modelBindingId: null });
  return new Response(null, { status: 204 });
});
