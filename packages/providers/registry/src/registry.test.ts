import { describe, expect, it } from 'vitest';
import { asProviderType } from '@salvations/core';
import {
  KNOWN_PROVIDER_TYPES, capabilitiesAreStale, createRegistry, isKnownProviderType,
} from './index';

const creds = { apiKey: 'test-key-not-real' };

describe('provider registry', () => {
  it('knows exactly the adapters that exist', () => {
    expect(KNOWN_PROVIDER_TYPES.map(String).sort()).toEqual(['anthropic', 'openai']);
  });

  it('constructs every known provider', () => {
    const registry = createRegistry();
    for (const type of KNOWN_PROVIDER_TYPES) {
      const provider = registry.create(type, creds);
      expect(provider.providerType).toBe(type);
    }
  });

  it('rejects an unknown type with an actionable message', () => {
    // A typo in configuration should fail clearly here, not at the first
    // inference call hours later.
    expect(() => createRegistry().create(asProviderType('anthrpic'), creds))
      .toThrow(/No adapter for provider type/);
  });

  it('validates a stored provider type at the boundary', () => {
    expect(isKnownProviderType('openai')).toBe(true);
    expect(isKnownProviderType('not-a-vendor')).toBe(false);
  });

  it('can be constructed with a narrowed set, for tests and for gating a rollout', () => {
    const registry = createRegistry([
      { providerType: asProviderType('only'), create: () => ({}) as never },
    ]);
    expect(registry.knownTypes().map(String)).toEqual(['only']);
    expect(registry.has(asProviderType('anthropic'))).toBe(false);
  });

  it('every adapter reports capabilities for its own default model', async () => {
    const registry = createRegistry();
    for (const type of KNOWN_PROVIDER_TYPES) {
      const provider = registry.create(type, creds);
      const caps = await provider.describeModel('some-unknown-model');
      // An unrecognised model degrades to a conservative profile rather than
      // throwing, so a newly released model does not take the platform down.
      expect(caps.maxInputTokens).toBeGreaterThan(0);
      expect(caps.streaming).toBe(true);
    }
  });
});

describe('capability cache staleness', () => {
  const now = new Date('2026-09-15T00:00:00Z');

  it('treats a never-fetched descriptor as stale', () => {
    expect(capabilitiesAreStale(null, now)).toBe(true);
    expect(capabilitiesAreStale(undefined, now)).toBe(true);
  });

  it('keeps a fresh descriptor', () => {
    expect(capabilitiesAreStale(new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  it('expires a descriptor past the TTL', () => {
    expect(capabilitiesAreStale(new Date(now.getTime() - 48 * 3600_000), now)).toBe(true);
  });
});
