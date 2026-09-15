/**
 * Provider registry.
 *
 * The one place that knows which vendors exist. packages/core deliberately does
 * not: ProviderType is an opaque string there, so adding a vendor never edits
 * the domain, and the architectural invariants keep the runtime free of vendor
 * names.
 */
import {
  Errors, asProviderType,
  type AgentProvider, type AgentProviderFactory, type ProviderCredentials,
  type ProviderRegistry, type ProviderType,
} from '@salvations/core';
import { createProvider as createAnthropic, PROVIDER_TYPE as ANTHROPIC } from '@salvations/provider-anthropic';
import { createProvider as createOpenAI, PROVIDER_TYPE as OPENAI } from '@salvations/provider-openai';
import { createProvider as createGoogle, PROVIDER_TYPE as GOOGLE } from '@salvations/provider-google';

const FACTORIES: readonly AgentProviderFactory[] = [
  { providerType: ANTHROPIC, create: (c) => createAnthropic(c) },
  { providerType: OPENAI, create: (c) => createOpenAI(c) },
  { providerType: GOOGLE, create: (c) => createGoogle(c) },
];

/**
 * Vendor types that may be stored on a providerConfig.
 *
 * Validated at the boundary so a typo becomes a clear configuration error
 * rather than a failure at the first inference call, hours later.
 */
export const KNOWN_PROVIDER_TYPES: readonly ProviderType[] = FACTORIES.map((f) => f.providerType);

export const isKnownProviderType = (value: string): value is string & ProviderType =>
  KNOWN_PROVIDER_TYPES.includes(asProviderType(value));

class DefaultProviderRegistry implements ProviderRegistry {
  readonly #factories: ReadonlyMap<string, AgentProviderFactory>;

  constructor(factories: readonly AgentProviderFactory[] = FACTORIES) {
    this.#factories = new Map(factories.map((f) => [String(f.providerType), f]));
  }

  has(providerType: ProviderType): boolean {
    return this.#factories.has(String(providerType));
  }

  create(providerType: ProviderType, credentials: ProviderCredentials): AgentProvider {
    const factory = this.#factories.get(String(providerType));
    if (factory === undefined) {
      throw Errors.unsupported(
        `No adapter for provider type "${String(providerType)}". Known: ` +
          `${KNOWN_PROVIDER_TYPES.map(String).join(', ')}.`,
      );
    }
    return factory.create(credentials);
  }

  knownTypes(): readonly ProviderType[] {
    return [...this.#factories.values()].map((f) => f.providerType);
  }
}

export const createRegistry = (
  factories?: readonly AgentProviderFactory[],
): ProviderRegistry => new DefaultProviderRegistry(factories);

/**
 * Capability descriptors are cached on the model binding and refreshed on a
 * TTL. A stale descriptor degrades rather than fails: every consumer treats an
 * absent capability as "not supported".
 */
export const CAPABILITIES_TTL_MS = 24 * 60 * 60 * 1000;

export const capabilitiesAreStale = (fetchedAt: Date | null | undefined, now = new Date()): boolean =>
  fetchedAt === null || fetchedAt === undefined ||
  now.getTime() - fetchedAt.getTime() > CAPABILITIES_TTL_MS;
