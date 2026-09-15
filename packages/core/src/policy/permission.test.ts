import { describe, expect, it } from 'vitest';
import { decidePermission, type PermissionInput, type PolicyDocument } from './permission.js';
import type { McpCapability, TrustTier } from '../entities/mcp.js';
import { asId } from '../ids.js';
import type { McpBindingId, PolicyId, WorkspaceId } from '../ids.js';

const WS = asId<WorkspaceId>('wks_1');
const BINDING = asId<McpBindingId>('mcb_linear');
const OTHER_BINDING = asId<McpBindingId>('mcb_gmail');

const HASH = 'sha256:abc';

function capability(over: Partial<McpCapability> = {}): McpCapability {
  return {
    id: asId('cap_1'),
    workspaceId: WS,
    bindingId: BINDING,
    scopeKey: 'workspace',
    kind: 'tool',
    name: 'create_issue',
    canonicalName: 'linear__create_issue',
    definitionHash: HASH,
    approval: { state: 'approved', definitionHash: HASH },
    firstSeenAt: new Date(0),
    lastSeenAt: new Date(0),
    ...over,
  };
}

function policy(scopeType: PolicyDocument['scopeType'], rules: PolicyDocument['rules']): PolicyDocument {
  return { id: asId<PolicyId>(`pol_${scopeType}`), workspaceId: WS, scopeType, rules };
}

function input(over: Partial<PermissionInput> = {}): PermissionInput {
  return {
    capability: capability(),
    bindingId: BINDING,
    trustTier: 'first_party' as TrustTier,
    args: {},
    policies: [],
    defaultEffect: 'ask',
    callsThisRun: 0,
    ...over,
  };
}

describe('decidePermission — fail closed', () => {
  it('falls back to the workspace default when nothing matches', () => {
    const d = decidePermission(input());
    expect(d.effect).toBe('ask');
    expect(d.reason).toBe('policy:default');
  });

  it('denies a capability whose definition changed after approval', () => {
    // The rug pull: the server altered the tool after an admin approved it.
    const d = decidePermission(
      input({
        capability: capability({ definitionHash: 'sha256:CHANGED' }),
        policies: [policy('workspace', [
          { id: 'r', capabilityPattern: '*', effect: 'allow', priority: 100 },
        ])],
      }),
    );
    expect(d.effect).toBe('deny');
    expect(d.reason).toBe('capability_changed');
  });

  it('denies a capability that was never approved, even with an allow rule', () => {
    const d = decidePermission(
      input({
        capability: capability({ approval: { state: 'pending', definitionHash: HASH } }),
        policies: [policy('workspace', [
          { id: 'r', capabilityPattern: '*', effect: 'allow', priority: 100 },
        ])],
      }),
    );
    expect(d.effect).toBe('deny');
    expect(d.reason).toBe('not_approved');
  });

  it('denies a removed capability', () => {
    const d = decidePermission(input({ capability: capability({ removedAt: new Date() }) }));
    expect(d.effect).toBe('deny');
    expect(d.reason).toBe('removed');
  });
});

describe('decidePermission — effect resolution', () => {
  it('lets deny win over a higher-priority allow', () => {
    const d = decidePermission(
      input({
        policies: [policy('workspace', [
          { id: 'allow', capabilityPattern: 'create_issue', effect: 'allow', priority: 1000 },
          { id: 'deny', capabilityPattern: '*', effect: 'deny', priority: 1 },
        ])],
      }),
    );
    expect(d.effect).toBe('deny');
    expect(d.matchedRuleId).toBe('deny');
  });

  it('lets a specific allow override a broad ask — the approval-fatigue defence', () => {
    const d = decidePermission(
      input({
        policies: [
          policy('workspace', [{ id: 'broad', capabilityPattern: '*', effect: 'ask', priority: 10 }]),
          policy('agent', [{ id: 'exact', capabilityPattern: 'create_issue', effect: 'allow', priority: 50 }]),
        ],
      }),
    );
    expect(d.effect).toBe('allow');
    expect(d.matchedRuleId).toBe('exact');
  });

  it('breaks an exact priority+specificity tie in favour of ask', () => {
    const d = decidePermission(
      input({
        policies: [policy('workspace', [
          { id: 'a', capabilityPattern: 'create_issue', effect: 'allow', priority: 10 },
          { id: 'b', capabilityPattern: 'create_issue', effect: 'ask', priority: 10 },
        ])],
      }),
    );
    expect(d.effect).toBe('ask');
  });

  it('matches on the canonical name as well as the bare name', () => {
    const d = decidePermission(
      input({
        policies: [policy('workspace', [
          { id: 'canon', capabilityPattern: 'linear__*', effect: 'allow', priority: 10 },
        ])],
      }),
    );
    expect(d.effect).toBe('allow');
  });

  it('ignores a rule scoped to a different binding', () => {
    const d = decidePermission(
      input({
        policies: [policy('workspace', [
          { id: 'other', bindingId: OTHER_BINDING, capabilityPattern: '*', effect: 'allow', priority: 99 },
        ])],
      }),
    );
    expect(d.effect).toBe('ask');
    expect(d.reason).toBe('policy:default');
  });
});

describe('decidePermission — server hints are a floor, never a ceiling', () => {
  const allowAll = [policy('workspace', [
    { id: 'allow', capabilityPattern: '*', effect: 'allow', priority: 10 },
  ])];

  it('raises allow to ask when an untrusted server does not prove the tool is read-only', () => {
    const d = decidePermission(
      input({ trustTier: 'community', policies: allowAll, capability: capability({ annotations: {} }) }),
    );
    expect(d.effect).toBe('ask');
    expect(d.tightenedByFloor).toBe(true);
  });

  it('raises allow to ask when a community server admits the tool is destructive', () => {
    const d = decidePermission(
      input({
        trustTier: 'community',
        policies: allowAll,
        capability: capability({ annotations: { readOnlyHint: true, destructiveHint: true } }),
      }),
    );
    expect(d.effect).toBe('ask');
  });

  it('honours a read-only hint from a verified server', () => {
    const d = decidePermission(
      input({
        trustTier: 'verified',
        policies: allowAll,
        capability: capability({ annotations: { readOnlyHint: true } }),
      }),
    );
    expect(d.effect).toBe('allow');
    expect(d.tightenedByFloor).toBe(false);
  });

  it('never lets a hint downgrade a deny', () => {
    const d = decidePermission(
      input({
        trustTier: 'community',
        capability: capability({ annotations: { readOnlyHint: true } }),
        policies: [policy('workspace', [
          { id: 'deny', capabilityPattern: '*', effect: 'deny', priority: 1 },
        ])],
      }),
    );
    expect(d.effect).toBe('deny');
  });

  it('never lets a hint downgrade an ask', () => {
    const d = decidePermission(
      input({
        trustTier: 'community',
        capability: capability({ annotations: { readOnlyHint: true } }),
        policies: [policy('workspace', [
          { id: 'ask', capabilityPattern: '*', effect: 'ask', priority: 1 },
        ])],
      }),
    );
    expect(d.effect).toBe('ask');
  });
});

describe('decidePermission — constraints', () => {
  it('stops matching a rule once its per-run call cap is reached', () => {
    const policies = [policy('workspace', [
      { id: 'capped', capabilityPattern: '*', effect: 'allow', priority: 10,
        constraints: { maxCallsPerRun: 2 } },
    ])];
    expect(decidePermission(input({ policies, callsThisRun: 1 })).effect).toBe('allow');
    // Cap reached: the rule no longer matches, so we fall through to the default.
    expect(decidePermission(input({ policies, callsThisRun: 2 })).effect).toBe('ask');
  });

  it('applies a rule only when its argument matchers are satisfied', () => {
    const policies = [policy('workspace', [
      { id: 'scoped', capabilityPattern: '*', effect: 'allow', priority: 10,
        constraints: { argMatchers: [{ path: 'team.id', op: 'equals', value: 'eng' }] } },
    ])];
    expect(decidePermission(input({ policies, args: { team: { id: 'eng' } } })).effect).toBe('allow');
    expect(decidePermission(input({ policies, args: { team: { id: 'sales' } } })).effect).toBe('ask');
    expect(decidePermission(input({ policies, args: {} })).effect).toBe('ask');
  });

  it('supports a numeric ceiling matcher', () => {
    const policies = [policy('workspace', [
      { id: 'small', capabilityPattern: '*', effect: 'allow', priority: 10,
        constraints: { argMatchers: [{ path: 'amount', op: 'maxNumber', value: 100 }] } },
    ])];
    expect(decidePermission(input({ policies, args: { amount: 50 } })).effect).toBe('allow');
    expect(decidePermission(input({ policies, args: { amount: 500 } })).effect).toBe('ask');
  });
});
