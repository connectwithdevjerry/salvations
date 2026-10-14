import { describe, expect, it } from 'vitest';
import { UNCONFIGURED, type Entitlements } from '@salvations/billing';
import { countGateFor, monthOf } from './limits';

const plan: Entitlements = {
  planId: 'standard', active: true, unconfigured: false, state: 'subscribed',
  limits: { agents: 3, channels: 2, mcpServers: 5, monthlyUsdCap: 250 },
};

describe('countGateFor', () => {
  it('lets an unbilled deployment do anything', () => {
    expect(countGateFor(UNCONFIGURED, 'agents', 1_000).allowed).toBe(true);
  });
  it('allows up to the ceiling and refuses the one past it, with the numbers', () => {
    expect(countGateFor(plan, 'agents', 2).allowed).toBe(true);
    const refused = countGateFor(plan, 'agents', 3);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('Your plan includes 3 assistants, and you have 3. Remove one, or ask for a larger plan.');
  });
  it('refuses a team whole when it would not fit, saying how many it adds', () => {
    expect(countGateFor(plan, 'agents', 1, 2).allowed).toBe(true);
    const refused = countGateFor(plan, 'agents', 1, 3);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain('this would add 3');
  });
  it('refuses everything without an active subscription', () => {
    const lapsed = { ...plan, active: false };
    expect(countGateFor(lapsed, 'channels', 0).allowed).toBe(false);
  });
});

describe('monthOf', () => {
  it('keys the month the way the usage rollup does', () => {
    expect(monthOf(new Date('2026-10-14T12:00:00Z'))).toBe('2026-10');
  });
});
