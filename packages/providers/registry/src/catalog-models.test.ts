/**
 * The catalogue and the adapters must agree about which models exist.
 *
 * This lives in the registry because it is the only package that imports all
 * three adapters. The failure it guards against is quiet and expensive: an
 * adapter falls back to a conservative profile for a model it does not know —
 * a 200K window and an 8K output cap — so a catalogued-but-unknown model still
 * RUNS, and the only symptom is conversations truncated far earlier than the
 * vendor's actual limit, with nothing in any log to say why.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_MODELS, defaultBindings, modelsFor, rateHasExpired } from '@salvations/catalog';
import { knownModels as anthropicModels } from '@salvations/provider-anthropic';
import { knownModels as openaiModels } from '@salvations/provider-openai';
import { KNOWN_PROVIDER_TYPES } from './index';

const KNOWN: Readonly<Record<string, () => readonly string[]>> = {
  anthropic: anthropicModels,
  openai: openaiModels,
};

describe('the catalogue against the adapters', () => {
  it('never offers a model its adapter cannot describe', () => {
    for (const model of CATALOG_MODELS) {
      const known = KNOWN[model.providerType];
      expect(known, `no adapter for provider type "${model.providerType}"`).toBeDefined();
      expect(
        known?.(),
        `"${model.id}" is catalogued but ${model.providerType} has no capability profile for it, `
        + 'so it would silently run on the fallback window',
      ).toContain(model.id);
    }
  });

  it('names only provider types the registry has an adapter for', () => {
    const types = new Set(KNOWN_PROVIDER_TYPES.map(String));
    for (const model of CATALOG_MODELS) {
      expect(types).toContain(model.providerType);
    }
  });

  it('offers something for every provider type the registry knows', () => {
    // A vendor with an adapter and no catalogue entries is a vendor nobody can
    // pick from the UI — installed and invisible.
    for (const type of KNOWN_PROVIDER_TYPES.map(String)) {
      expect(modelsFor(type).length, `nothing catalogued for ${type}`).toBeGreaterThan(0);
    }
  });

  it('has no duplicate model ids', () => {
    const ids = CATALOG_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('rates', () => {
  it('dates every rate it states', () => {
    // A price with no date is a price nobody can judge the age of, and these
    // change often enough that the date is the useful part.
    for (const model of CATALOG_MODELS) {
      if (model.rates === undefined) continue;
      expect(model.rates.checkedOn, `${model.id} has a rate with no date`)
        .toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never states a zero rate', () => {
    /*
     * Zero is the dangerous value: budgets are enforced against these, so a
     * zero rate is a run that can never exceed its budget. Absent is the
     * honest way to say "we do not know" — and the UI asks.
     */
    for (const model of CATALOG_MODELS) {
      if (model.rates === undefined) continue;
      expect(model.rates.inputPerMTok, `${model.id} input rate`).toBeGreaterThan(0);
      expect(model.rates.outputPerMTok, `${model.id} output rate`).toBeGreaterThan(0);
    }
  });

  it('flags an introductory rate once its date has passed', () => {
    // The silent failure this exists for: a budget set on a promotional rate
    // keeps reporting the old cost after it ends, and spend quietly exceeds
    // what the workspace agreed to.
    const promo = { inputPerMTok: 1, outputPerMTok: 2, checkedOn: '2026-01-01', introductoryUntil: '2026-12-31' };

    expect(rateHasExpired(promo, new Date('2026-06-01'))).toBe(false);
    expect(rateHasExpired(promo, new Date('2027-01-02'))).toBe(true);
    // A rate with no promotion never expires.
    expect(rateHasExpired({ inputPerMTok: 1, outputPerMTok: 2, checkedOn: '2026-01-01' })).toBe(false);
    expect(rateHasExpired(undefined)).toBe(false);
  });
});

describe('default bindings', () => {
  it('gives every vendor a chat model, since an agent naming no role gets it', () => {
    for (const type of KNOWN_PROVIDER_TYPES.map(String)) {
      const roles = defaultBindings(type).map((b) => b.role);
      expect(roles, `${type} has no default chat binding`).toContain('chat');
    }
  });

  it('never suggests the same role twice', () => {
    for (const type of KNOWN_PROVIDER_TYPES.map(String)) {
      const roles = defaultBindings(type).map((b) => b.role);
      expect(new Set(roles).size).toBe(roles.length);
    }
  });

  it('only suggests models from that vendor', () => {
    for (const type of KNOWN_PROVIDER_TYPES.map(String)) {
      for (const binding of defaultBindings(type)) {
        expect(binding.model.providerType).toBe(type);
      }
    }
  });
});
