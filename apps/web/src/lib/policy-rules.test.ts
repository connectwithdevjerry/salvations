import { describe, expect, it } from 'vitest';
import type { PolicyRule } from '@salvations/core';
import { rememberAllow } from './policy-rules';

const rule = (over: Partial<PolicyRule>): PolicyRule => ({
  id: 'r', capabilityPattern: '*', effect: 'ask', priority: 10, ...over,
});

describe('rememberAllow', () => {
  it('adds an allow rule for exactly that tool on that connection', () => {
    const rules = rememberAllow([], 'mcb_1', 'send_mail');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ bindingId: 'mcb_1', capabilityPattern: 'send_mail', effect: 'allow', priority: 50 });
    expect(rules[0]?.id).toMatch(/^rule_/);
  });

  it('replaces an earlier rule aimed at the same tool, whatever it said', () => {
    const before = [
      rule({ id: 'deny_it', bindingId: 'mcb_1' as never, capabilityPattern: 'send_mail', effect: 'deny' }),
      rule({ id: 'other', bindingId: 'mcb_1' as never, capabilityPattern: 'read_mail', effect: 'allow' }),
    ];
    const after = rememberAllow(before, 'mcb_1', 'send_mail');
    expect(after.map((r) => r.id)).not.toContain('deny_it');
    expect(after.map((r) => r.id)).toContain('other');
    expect(after.filter((r) => r.capabilityPattern === 'send_mail')).toHaveLength(1);
  });

  it('leaves a broad rule alone: it was not about this tool in particular', () => {
    const before = [rule({ id: 'broad', capabilityPattern: '*', effect: 'ask' })];
    expect(rememberAllow(before, 'mcb_1', 'send_mail').map((r) => r.id)).toContain('broad');
  });
});
