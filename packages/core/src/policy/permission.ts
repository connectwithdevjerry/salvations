/**
 * PermissionBroker evaluation — pure, synchronous, fully testable.
 *
 * Every MCP invocation passes through here. No exemptions, including for
 * platform-owned servers. See docs/SECURITY.md §3.3.
 *
 * Two properties carry the weight:
 *   - Fail closed. No matching rule means the workspace default, which ships as 'ask'.
 *   - Server-supplied metadata can only TIGHTEN a decision, never loosen it.
 */
import type { McpBindingId, PolicyId, WorkspaceId } from '../ids.js';
import type { McpCapability, TrustTier } from '../entities/mcp.js';
import { capabilityBlockReason } from '../entities/mcp.js';
import type { PermissionEffect } from '../entities/run.js';
import { globMatches, patternSpecificity } from './pattern.js';

export type PolicyScopeType = 'workspace' | 'agent' | 'member' | 'apiKey' | 'channel';

const SCOPE_RANK: Readonly<Record<PolicyScopeType, 0 | 1 | 2>> = Object.freeze({
  workspace: 0, agent: 1, member: 2, apiKey: 2, channel: 2,
});

export type ArgMatcher =
  | { readonly path: string; readonly op: 'equals'; readonly value: unknown }
  | { readonly path: string; readonly op: 'oneOf'; readonly values: readonly unknown[] }
  | { readonly path: string; readonly op: 'matches'; readonly pattern: string }
  | { readonly path: string; readonly op: 'exists' }
  | { readonly path: string; readonly op: 'maxNumber'; readonly value: number };

export interface RuleConstraints {
  readonly argMatchers?: readonly ArgMatcher[];
  readonly maxCallsPerRun?: number;
  readonly maxCallsPerHour?: number;
}

export interface PolicyRule {
  readonly id: string;
  /** undefined or '*' matches any binding. */
  readonly bindingId?: McpBindingId | '*';
  readonly capabilityPattern: string;
  readonly effect: PermissionEffect;
  readonly priority: number;
  readonly constraints?: RuleConstraints;
}

export interface PolicyDocument {
  readonly id: PolicyId;
  readonly workspaceId: WorkspaceId;
  readonly scopeType: PolicyScopeType;
  readonly scopeId?: string;
  readonly rules: readonly PolicyRule[];
}

export interface PermissionInput {
  readonly capability: McpCapability;
  readonly bindingId: McpBindingId;
  readonly trustTier: TrustTier;
  readonly args: unknown;
  /** Workspace → agent → principal. At most three documents. */
  readonly policies: readonly PolicyDocument[];
  readonly defaultEffect: PermissionEffect;
  readonly callsThisRun: number;
}

export interface PermissionDecision {
  readonly effect: PermissionEffect;
  readonly matchedRuleId?: string;
  readonly reason: string;
  /** True when a server hint or trust tier raised the effect above the matched rule. */
  readonly tightenedByFloor: boolean;
}

interface Candidate {
  readonly rule: PolicyRule;
  readonly scope: PolicyScopeType;
  readonly specificity: number;
}

/**
 * Rule ranking. Pattern precision dominates, then binding precision, then scope.
 *
 * Pattern first is deliberate: an operator writing an exact tool name means that
 * rule, and a broad workspace default should not outrank it. Without this,
 * "generally ask, but these read-only tools are fine" is inexpressible — and
 * that rule is the main defence against approval fatigue.
 */
const specificityOf = (rule: PolicyRule, scope: PolicyScopeType): number => {
  const pattern = patternSpecificity(rule.capabilityPattern);
  const binding = rule.bindingId !== undefined && rule.bindingId !== '*' ? 1 : 0;
  return pattern * 100 + binding * 10 + SCOPE_RANK[scope];
};

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function argMatcherSatisfied(matcher: ArgMatcher, args: unknown): boolean {
  const value = getPath(args, matcher.path);
  switch (matcher.op) {
    case 'exists': return value !== undefined;
    case 'equals': return Object.is(value, matcher.value);
    case 'oneOf': return matcher.values.some((v) => Object.is(v, value));
    case 'matches': return typeof value === 'string' && globMatches(matcher.pattern, value);
    case 'maxNumber': return typeof value === 'number' && value <= matcher.value;
  }
}

const constraintsSatisfied = (rule: PolicyRule, input: PermissionInput): boolean => {
  const c = rule.constraints;
  if (c === undefined) return true;
  if (c.maxCallsPerRun !== undefined && input.callsThisRun >= c.maxCallsPerRun) return false;
  if (c.argMatchers !== undefined) {
    return c.argMatchers.every((m) => argMatcherSatisfied(m, input.args));
  }
  return true;
};

/**
 * Server-supplied annotations act as a FLOOR on the effect, never a ceiling.
 *
 * Annotations come from code we do not control. A server claiming to be harmless
 * must never be able to downgrade a policy; a server admitting it is destructive
 * may raise the bar.
 */
function applyAnnotationFloor(
  effect: PermissionEffect,
  capability: McpCapability,
  trustTier: TrustTier,
): { effect: PermissionEffect; tightened: boolean } {
  if (effect !== 'allow') return { effect, tightened: false };
  if (trustTier === 'first_party') return { effect, tightened: false };

  const ann = capability.annotations ?? {};
  const readOnly = ann['readOnlyHint'];
  const destructive = ann['destructiveHint'];

  // Explicitly not read-only, or explicitly destructive, or simply unstated:
  // an unstated hint from a non-first-party server is not evidence of safety.
  const notProvenSafe = readOnly !== true;
  if (destructive === true || notProvenSafe) {
    return { effect: 'ask', tightened: true };
  }
  return { effect, tightened: false };
}

export function decidePermission(input: PermissionInput): PermissionDecision {
  // 1. The capability must be usable at its CURRENT definition hash.
  const blocked = capabilityBlockReason(input.capability);
  if (blocked !== undefined) {
    return {
      effect: 'deny',
      reason: blocked,
      tightenedByFloor: false,
    };
  }

  // 2/3. Collect and rank every matching rule across all scopes.
  const candidates: Candidate[] = [];
  for (const doc of input.policies) {
    for (const rule of doc.rules) {
      const bindingOk =
        rule.bindingId === undefined ||
        rule.bindingId === '*' ||
        rule.bindingId === input.bindingId;
      if (!bindingOk) continue;
      if (!globMatches(rule.capabilityPattern, input.capability.name) &&
          !globMatches(rule.capabilityPattern, input.capability.canonicalName)) continue;
      if (!constraintsSatisfied(rule, input)) continue;
      candidates.push({ rule, scope: doc.scopeType, specificity: specificityOf(rule, doc.scopeType) });
    }
  }

  // 4. Deny is absolute: it wins over any priority or specificity.
  const denial = candidates.find((c) => c.rule.effect === 'deny');
  if (denial !== undefined) {
    return {
      effect: 'deny',
      matchedRuleId: denial.rule.id,
      reason: 'policy:deny',
      tightenedByFloor: false,
    };
  }

  // 5. Highest priority wins; ties broken by specificity; exact ties favour 'ask'.
  const winner = candidates.reduce<Candidate | undefined>((best, c) => {
    if (best === undefined) return c;
    if (c.rule.priority !== best.rule.priority) {
      return c.rule.priority > best.rule.priority ? c : best;
    }
    if (c.specificity !== best.specificity) {
      return c.specificity > best.specificity ? c : best;
    }
    return c.rule.effect === 'ask' ? c : best;
  }, undefined);

  const base: PermissionEffect = winner?.rule.effect ?? input.defaultEffect;
  const reason = winner !== undefined ? `policy:${winner.rule.effect}` : 'policy:default';

  // 6. Floors may only tighten.
  const floored = applyAnnotationFloor(base, input.capability, input.trustTier);

  return {
    effect: floored.effect,
    ...(winner !== undefined ? { matchedRuleId: winner.rule.id } : {}),
    reason: floored.tightened ? `${reason}+annotation_floor` : reason,
    tightenedByFloor: floored.tightened,
  };
}
