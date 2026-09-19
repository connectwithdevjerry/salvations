/**
 * Provider configurations.
 *
 * The API key is stored as an encrypted credential and never returned. What
 * comes back is a hint — enough to tell two keys apart in a list, and not
 * enough to be one.
 */
import { createProviderConfigSchema } from '@salvations/contracts';
import { KNOWN_PROVIDER_TYPES, isKnownProviderType } from '@salvations/provider-registry';
import { CATALOG_MODELS, defaultBindings, modelsFor } from '@salvations/catalog';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { providers } from '@/lib/singletons';

export const runtime = 'nodejs';

export const GET = workspaceRoute('providers:read', async (ctx) => {
  const items = await ctx.repos.models.listProviders();
  // The hint lives with the CREDENTIAL, not on the provider row: it describes
  // the secret, and keeping it beside the secret is what stops a second copy
  // drifting after a rotation.
  const credentials = await ctx.repos.credentials.list();
  const hintById = new Map(credentials.map((c) => [c._id, c.hint]));

  return ok({
    // The vendors this deployment can actually talk to, so the UI offers a list
    // it did not invent. A name typed into a form is a configuration error
    // hours later; a name absent from this list cannot be chosen at all.
    knownTypes: KNOWN_PROVIDER_TYPES.map(String),
    // The models this deployment can actually offer, with rates where one could
    // be stated. The UI picks from these rather than asking somebody to type a
    // model id — an unrecognised one still runs, on a fallback profile, and
    // truncates conversations for no visible reason.
    models: CATALOG_MODELS,
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
      // The vendor's verdict, or nothing for a key stored before keys were
      // checked. The UI must not read "nothing" as "connected".
      lastCheck: p.lastCheck === null || p.lastCheck === undefined ? undefined : {
        at: p.lastCheck.at.toISOString(), ok: p.lastCheck.ok, message: p.lastCheck.message ?? undefined,
      },
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

  // Checked BEFORE anything is stored, so a bad model id leaves no orphaned
  // key or provider behind. The person may have picked a chat model; anything
  // else stays the catalogue's default. Only a model the catalogue lists for this vendor —
  // an id typed from memory is exactly the mistake the catalogue exists to stop.
  const chosen = input.chatModelId === undefined
    ? undefined
    : modelsFor(input.providerType).find((m) => m.id === input.chatModelId);
  if (input.chatModelId !== undefined && chosen === undefined) {
    return errorResponse(
      422, 'validation_failed',
      `"${input.chatModelId}" is not a ${input.providerType} model this deployment offers.`,
    );
  }

  /*
   * The key is tried against the vendor BEFORE it is stored.
   *
   * A wrong key stored quietly becomes an assistant that never answers, on
   * Telegram and in the browser, with nothing on any page saying why. Refusing
   * it here puts the vendor's own verdict in front of the person while the key
   * is still in the box.
   */
  const check = await providers().create(input.providerType as never, {
    apiKey: input.apiKey,
    ...(input.baseUrl !== undefined && input.baseUrl !== null ? { baseUrl: input.baseUrl } : {}),
  }).verify?.();
  if (check !== undefined && !check.ok) {
    const vendor = input.name;
    return check.kind === 'rejected'
      ? errorResponse(
        422, 'provider_rejected_key',
        `${vendor} did not accept that key (${check.message}). Check it and try again.`,
      )
      : errorResponse(
        502, 'provider_unreachable',
        `${vendor} could not be reached to check the key (${check.message}). Try again in a moment.`,
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
    // Checked a moment ago, above. An adapter with no check leaves it unknown.
    lastCheck: check === undefined ? null : { at: new Date(), ok: true, message: null },
  });

  /*
   * Bind the suggested roles straight away.
   *
   * Connecting a key should leave a workspace able to run, not facing three
   * more forms. Only roles nothing is bound to yet: a second provider must not
   * silently take the chat role from the one already answering.
   */
  const existing = await ctx.repos.models.list();
  const taken = new Set(existing.filter((b) => b.enabled).map((b) => b.role));
  const created: string[] = [];

  const suggestions = defaultBindings(input.providerType).map((suggestion) =>
    suggestion.role === 'chat' && chosen !== undefined ? { ...suggestion, model: chosen } : suggestion);

  for (const suggestion of suggestions) {
    if (taken.has(suggestion.role)) continue;
    await ctx.repos.models.createBinding({
      providerConfigId: provider._id,
      modelId: suggestion.model.id,
      displayName: suggestion.model.displayName,
      role: suggestion.role,
      params: {},
      capabilities: null,
      capabilitiesFetchedAt: null,
      cost: {
        // Zero when the catalogue could not state a rate honestly. That shows
        // on the models page as "rate not set", which is the truth — and better
        // than a guess, which would enforce a budget against a number nobody
        // chose and looks correct while doing it.
        inputPerMTok: suggestion.model.rates?.inputPerMTok ?? 0,
        outputPerMTok: suggestion.model.rates?.outputPerMTok ?? 0,
      },
      fallbackBindingId: null,
      enabled: true,
    });
    created.push(suggestion.role);
  }

  return ok({
    id: provider._id,
    providerType: provider.providerType,
    name: input.name,
    boundRoles: created,
  }, 201);
});
