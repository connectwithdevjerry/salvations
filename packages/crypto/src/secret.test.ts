import { describe, expect, it, vi, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { EphemeralSecret, Secret, isSecret } from './secret';

afterEach(() => { vi.useRealTimers(); });

describe('Secret resists accidental disclosure', () => {
  const secret = new Secret('sk-live-do-not-log', 'api_key');

  it('hides the value from string interpolation', () => {
    expect(`${secret}`).toBe('[redacted]');
    expect(String(secret)).toBe('[redacted]');
  });

  it('hides the value from JSON.stringify, including when nested', () => {
    expect(JSON.stringify(secret)).toBe('"[redacted]"');
    expect(JSON.stringify({ cfg: { credential: secret } })).not.toContain('do-not-log');
  });

  it('hides the value from util.inspect, which is what console.log uses', () => {
    expect(inspect(secret)).not.toContain('do-not-log');
    expect(inspect({ secret })).not.toContain('do-not-log');
  });

  it('requires an explicit expose() to read', () => {
    expect(secret.expose()).toBe('sk-live-do-not-log');
  });

  it('offers a correlatable hint that is not the value', () => {
    expect(secret.hint).toBe('api_key:****-log');
    expect(secret.hint).not.toContain('sk-live');
  });

  it('does not leak a short value through the hint', () => {
    expect(new Secret('abc', 'pin').hint).toBe('pin:****');
  });

  it('is recognisable at runtime', () => {
    expect(isSecret(secret)).toBe(true);
    expect(isSecret('sk-live')).toBe(false);
  });
});

describe('EphemeralSecret has a lifetime', () => {
  it('reads before expiry', () => {
    expect(new EphemeralSecret('value', 60_000).expose()).toBe('value');
  });

  it('throws after being destroyed rather than returning a stale value', () => {
    const s = new EphemeralSecret('value', 60_000);
    s.destroy();
    expect(s.destroyed).toBe(true);
    expect(() => s.expose()).toThrow(/destroyed/);
  });

  it('expires on time and destroys itself', () => {
    // A lifetime bug should be loud, not a silent reuse of an old credential.
    vi.useFakeTimers();
    const s = new EphemeralSecret('value', 1_000, 'oauth');
    vi.advanceTimersByTime(1_001);
    expect(() => s.expose()).toThrow(/expired/);
    expect(s.destroyed).toBe(true);
  });

  it('stays hidden from logging like Secret does', () => {
    const s = new EphemeralSecret('tok-do-not-log', 60_000);
    expect(JSON.stringify({ s })).not.toContain('do-not-log');
    expect(inspect(s)).not.toContain('do-not-log');
  });
});
