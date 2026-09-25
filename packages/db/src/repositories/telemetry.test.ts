import { describe, expect, it } from 'vitest';
import {
  CACHE_ALERT_MIN_TOKENS, CACHE_HIT_RATE_FLOOR, cacheAlert, type CacheHitRate,
} from './telemetry';

const measurement = (over: Partial<CacheHitRate> = {}): CacheHitRate => {
  const cacheReadTokens = over.cacheReadTokens ?? 900_000;
  const freshInputTokens = over.freshInputTokens ?? 100_000;
  const total = cacheReadTokens + freshInputTokens;
  return {
    day: '2026-01-01',
    cacheReadTokens,
    freshInputTokens,
    rate: over.rate !== undefined ? over.rate : total === 0 ? undefined : cacheReadTokens / total,
  };
};

describe('the cache-hit-rate alert', () => {
  it('stays quiet when the cache is doing its job', () => {
    expect(cacheAlert(measurement()).firing).toBe(false);
  });

  it('fires when the prefix is being perturbed', () => {
    // A loop re-sends the whole conversation every step, so at any real length
    // most input tokens should be cache reads. When they stop being, the bill
    // roughly triples with nothing else looking wrong.
    const alert = cacheAlert(measurement({ cacheReadTokens: 100_000, freshInputTokens: 900_000 }));
    expect(alert.firing).toBe(true);
    expect(alert.reason).toMatch(/reordered tool list or a varying system prompt/);
  });

  it('names the actual rate, so the alert is actionable on its own', () => {
    const alert = cacheAlert(measurement({ cacheReadTokens: 200_000, freshInputTokens: 800_000 }));
    expect(alert.reason).toContain('20.0%');
    expect(alert.reason).toContain('2026-01-01');
  });

  it('will not fire on a volume too small to mean anything', () => {
    // A rate computed from three thousand tokens is noise, and an alert that
    // fires on noise is one people learn to close.
    const quiet = measurement({ cacheReadTokens: 100, freshInputTokens: 2_900 });
    expect(quiet.rate).toBeLessThan(CACHE_HIT_RATE_FLOOR);
    expect(cacheAlert(quiet).firing).toBe(false);
  });

  it('distinguishes no data from a rate of zero', () => {
    // They mean opposite things to whoever is paged.
    const nothing = measurement({ cacheReadTokens: 0, freshInputTokens: 0 });
    expect(nothing.rate).toBeUndefined();
    expect(cacheAlert(nothing).firing).toBe(false);
  });

  it('treats the floor itself as acceptable', () => {
    const atFloor = measurement({
      cacheReadTokens: CACHE_HIT_RATE_FLOOR * CACHE_ALERT_MIN_TOKENS * 10,
      freshInputTokens: (1 - CACHE_HIT_RATE_FLOOR) * CACHE_ALERT_MIN_TOKENS * 10,
    });
    expect(atFloor.rate).toBeCloseTo(CACHE_HIT_RATE_FLOOR, 6);
    expect(cacheAlert(atFloor).firing).toBe(false);
  });
});
