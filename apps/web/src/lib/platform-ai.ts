/**
 * HIVE AI: a model that comes with the subscription.
 *
 * Until now every workspace brought its own Claude or OpenAI key. That is
 * still offered, and still where the heavier use belongs; but a person who
 * has just subscribed should be able to talk to an assistant before they
 * have been to a vendor's console. So a deployment may hold one key of its
 * own, and every workspace gets a provider called HIVE AI backed by it,
 * bound to the usual roles, with the deployment paying the vendor and the
 * plan's allowance capping what one workspace can spend of it a month.
 *
 * The vendor behind it is configuration, not code: OpenAI by default, as
 * the operator asked, and any vendor the registry knows will do. Nothing
 * here names one.
 *
 * The key is never written to a workspace: the HIVE AI provider row holds
 * no credential, and the key is read from the environment at the moment of
 * use, so it cannot be listed, exported or revoked from inside a workspace,
 * and rotating it is one change on the deployment.
 */
import { platformSettings } from './platform-settings';
import { defaultBindings, modelsFor, type ModelRole } from '@salvations/catalog';
import { isKnownProviderType } from '@salvations/provider-registry';
import { ModelBindingRepository, type Database, type ProviderConfigDoc } from '@salvations/db';
import type { CredentialRepository } from '@salvations/db';
import type { ProviderCredentials } from '@salvations/core';

export const PLATFORM_PROVIDER_NAME = 'HIVE AI';

/** Who created the rows. Not a person; must never be mistaken for one. */
const PLATFORM_ACTOR = 'platform';

export interface PlatformAi {
  readonly providerType: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** The catalogue model the chat role is bound to. */
  readonly chatModelId: string;
  /** What one workspace may spend of the deployment's key in a month, in dollars. */
  readonly monthlyUsdCap: number;
}

/**
 * The deployment's own model, or undefined when it has none. Misconfiguration
 * is an error, not a silent absence: a key with a vendor the registry does
 * not know, or a model the catalogue does not list, would otherwise be a
 * HIVE AI that every assistant fails on.
 */
export async function platformAi(): Promise<PlatformAi | undefined> {
  const [apiKey, provider, chatModel, baseUrl, cap] = await platformSettings(
    ['platform_ai_api_key', 'platform_ai_provider', 'platform_ai_chat_model', 'platform_ai_base_url', 'platform_ai_monthly_usd_cap'] as const,
  );
  if (apiKey === undefined) return undefined;
  const providerType = provider ?? 'openai';
  if (!isKnownProviderType(providerType)) {
    throw new Error(`The HIVE AI vendor is "${providerType}", which no adapter is registered for.`);
  }
  const models = modelsFor(providerType);
  const chat = chatModel !== undefined
    ? models.find((m) => m.id === chatModel)
    : models.find((m) => m.roles.includes('chat'));
  if (chat === undefined) {
    throw new Error(chatModel !== undefined
      ? `The HIVE AI chat model "${chatModel}" is not a ${providerType} model the catalogue lists.`
      : `The catalogue lists no chat model for ${providerType}.`);
  }
  const monthlyUsdCap = Number(cap ?? '25');
  if (!Number.isFinite(monthlyUsdCap) || monthlyUsdCap <= 0) {
    throw new Error(`The HIVE AI monthly allowance "${cap ?? ''}" is not a positive number of dollars.`);
  }
  return {
    providerType,
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    chatModelId: chat.id,
    monthlyUsdCap,
  };
}

/** Whether a provider row is the deployment's own rather than a key the workspace brought. */
export const isPlatformProvider = (provider: Pick<ProviderConfigDoc, 'platform'>): boolean => provider.platform === true;

/**
 * What a provider's adapter is given to speak to the vendor: the
 * deployment's key for HIVE AI, the workspace's stored key for the rest.
 * Decrypted at use and held only for the call.
 */
export async function providerCredentials(
  credentials: CredentialRepository,
  provider: Pick<ProviderConfigDoc, 'platform' | 'credentialId' | 'baseUrl'>,
): Promise<ProviderCredentials | undefined> {
  const withBase = (apiKey: string): ProviderCredentials => ({
    apiKey,
    ...(provider.baseUrl !== null && provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
  });
  if (isPlatformProvider(provider)) {
    const platform = await platformAi();
    return platform === undefined ? undefined : withBase(platform.apiKey);
  }
  if (provider.credentialId === null || provider.credentialId === undefined) return undefined;
  const secret = await credentials.resolve(provider.credentialId);
  return secret === null ? undefined : withBase(secret.expose());
}

/** The bindings HIVE AI makes for a workspace: the vendor's defaults, with the chat model the deployment chose. */
export function platformBindings(platform: PlatformAi): readonly { role: ModelRole; modelId: string; displayName: string; inputPerMTok: number; outputPerMTok: number }[] {
  const chosen = modelsFor(platform.providerType).find((m) => m.id === platform.chatModelId);
  return defaultBindings(platform.providerType)
    .map((s) => (s.role === 'chat' && chosen !== undefined ? { role: s.role, model: chosen } : s))
    .map(({ role, model }) => ({
      role,
      modelId: model.id,
      displayName: `${PLATFORM_PROVIDER_NAME} · ${model.displayName}`,
      inputPerMTok: model.rates?.inputPerMTok ?? 0,
      outputPerMTok: model.rates?.outputPerMTok ?? 0,
    }));
}

/**
 * Gives a workspace HIVE AI, once.
 *
 * Idempotent and cheap to call from anywhere a workspace's models are read:
 * a workspace made before the deployment had a key gets it on its next
 * visit, and a workspace that already has it is left alone. Only roles
 * nothing is bound to are taken, so a key the person brought keeps the
 * roles it has.
 */
export async function ensurePlatformAi(database: Database, workspaceId: string): Promise<ProviderConfigDoc | undefined> {
  const platform = await platformAi();
  if (platform === undefined) return undefined;

  const models = new ModelBindingRepository(database, workspaceId);
  const existing = (await models.listProviders()).find(isPlatformProvider);
  if (existing !== undefined) return existing;

  const now = new Date();
  const provider = await models.createProvider({
    providerType: platform.providerType,
    name: PLATFORM_PROVIDER_NAME,
    credentialId: null,
    baseUrl: platform.baseUrl ?? null,
    settings: {},
    enabled: true,
    createdBy: PLATFORM_ACTOR,
    createdAt: now,
    lastCheck: { at: now, ok: true, message: null },
    platform: true,
  });

  const taken = new Set((await models.list()).filter((b) => b.enabled).map((b) => b.role));
  for (const binding of platformBindings(platform)) {
    if (taken.has(binding.role)) continue;
    await models.createBinding({
      providerConfigId: provider._id,
      modelId: binding.modelId,
      displayName: binding.displayName,
      role: binding.role,
      params: {},
      capabilities: null,
      capabilitiesFetchedAt: null,
      cost: { inputPerMTok: binding.inputPerMTok, outputPerMTok: binding.outputPerMTok },
      fallbackBindingId: null,
      enabled: true,
    });
  }
  return provider;
}

/** The bindings that spend the deployment's key, for the monthly allowance. */
export async function platformBindingIds(database: Database, workspaceId: string): Promise<readonly string[]> {
  const models = new ModelBindingRepository(database, workspaceId);
  const platform = (await models.listProviders()).filter(isPlatformProvider).map((p) => p._id);
  if (platform.length === 0) return [];
  const mine = new Set(platform);
  return (await models.list()).filter((b) => mine.has(b.providerConfigId)).map((b) => b._id);
}

/** What the person is told when the month's allowance is used up. */
export const allowanceReason = (cap: number): string =>
  `This month's included AI allowance of $${cap.toFixed(cap % 1 === 0 ? 0 : 2)} has been used up. Add your own key on the Models page to keep going now, or wait for next month.`;
