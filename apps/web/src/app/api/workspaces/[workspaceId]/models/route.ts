/**
 * Model bindings — the vendor-swap point.
 *
 * An agent names a ROLE; a binding maps that role to a concrete model on a
 * concrete provider. Swapping a workspace from one vendor to another is
 * therefore a change here, not an edit to every agent.
 */
import { createModelBindingSchema } from '@salvations/contracts';
import { jsonBody, ok, errorResponse } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = workspaceRoute('providers:read', async (ctx) => {
  const bindings = await ctx.repos.models.list();
  const providers = await ctx.repos.models.listProviders();
  const byId = new Map(providers.map((p) => [p._id, p]));

  return ok({
    items: bindings.map((b) => ({
      id: b._id,
      name: b.displayName,
      providerType: byId.get(b.providerConfigId)?.providerType ?? 'unknown',
      modelId: b.modelId,
      role: b.role,
      // Reported so the page can show which bindings have no rate. A binding
      // costed at zero cannot exceed any budget, which looks like a budget
      // working right up until the invoice arrives.
      cost: { inputPerMTok: b.cost?.inputPerMTok ?? 0, outputPerMTok: b.cost?.outputPerMTok ?? 0 },
      fallbackBindingId: b.fallbackBindingId ?? undefined,
      // Read from the adapter and cached, never typed in by a person.
      capabilities: b.capabilities ?? undefined,
      enabled: b.enabled,
    })),
  });
});

export const POST = workspaceRoute('providers:write', async (ctx) => {
  const input = await jsonBody(ctx.request, createModelBindingSchema);

  const providers = await ctx.repos.models.listProviders();
  if (!providers.some((p) => p._id === input.providerConfigId)) {
    return errorResponse(404, 'not_found', 'Provider configuration not found.');
  }

  const binding = await ctx.repos.models.createBinding({
    providerConfigId: input.providerConfigId,
    modelId: input.modelId,
    displayName: input.name,
    role: input.role,
    params: {},
    capabilities: null,
    capabilitiesFetchedAt: null,
    cost: {
      inputPerMTok: input.rates?.inputPerMTok ?? 0,
      outputPerMTok: input.rates?.outputPerMTok ?? 0,
      ...(input.rates?.cacheReadPerMTok !== undefined
        ? { cacheReadPerMTok: input.rates.cacheReadPerMTok }
        : {}),
    },
    fallbackBindingId: input.fallbackBindingId ?? null,
    enabled: true,
  });

  return ok({ id: binding._id, name: input.name, modelId: input.modelId }, 201);
});
