/**
 * Provider configurations.
 *
 * The API key is stored as an encrypted credential and never returned. What
 * comes back is a hint — enough to tell two keys apart in a list, and not
 * enough to be one.
 */
import { createProviderConfigSchema } from '@salvations/contracts';
import { isKnownProviderType } from '@salvations/provider-registry';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

export const GET = workspaceRoute('providers:read', async (ctx) => {
  const items = await ctx.repos.models.listProviders();
  // The hint lives with the CREDENTIAL, not on the provider row: it describes
  // the secret, and keeping it beside the secret is what stops a second copy
  // drifting after a rotation.
  const credentials = await ctx.repos.credentials.list();
  const hintById = new Map(credentials.map((c) => [c._id, c.hint]));

  return ok({
    items: items.map((p) => ({
      id: p._id,
      providerType: p.providerType,
      name: p.name,
      baseUrl: p.baseUrl ?? undefined,
      keyHint: (p.credentialId !== null && p.credentialId !== undefined
        ? hintById.get(p.credentialId)
        : undefined) ?? '••••',
      enabled: p.enabled,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

export const POST = workspaceRoute('providers:write', async (ctx) => {
  const input = await jsonBody(ctx.request, createProviderConfigSchema);

  // Validated at the BOUNDARY, not in the domain: core refuses to enumerate
  // vendors, and the registry is the one place that knows which adapters exist.
  if (!isKnownProviderType(input.providerType)) {
    return errorResponse(
      422, 'validation_failed',
      `No adapter is registered for provider type "${input.providerType}".`,
    );
  }

  const credential = await ctx.repos.credentials.store({
    name: `${input.name} API key`,
    kind: 'api_key',
    plaintext: input.apiKey,
    createdBy: actorIdOf(ctx.principal),
    // The last four characters only. Enough to recognise a key, useless as one.
    hint: `••••${input.apiKey.slice(-4)}`,
  });

  const provider = await ctx.repos.models.createProvider({
    providerType: input.providerType,
    name: input.name,
    credentialId: credential._id,
    baseUrl: input.baseUrl ?? null,
    settings: {},
    enabled: true,
    createdBy: actorIdOf(ctx.principal),
    createdAt: new Date(),
  });

  return ok({ id: provider._id, providerType: provider.providerType, name: input.name }, 201);
});
