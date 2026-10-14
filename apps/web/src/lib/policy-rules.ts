/**
 * Rules, as the editor and the approval card write them.
 *
 * A rule is small: an effect, a connection or any, a tool name or a pattern.
 * What makes the set safe to edit by hand is in the engine, not here: a
 * specific name outranks a pattern, deny outranks everything, and a server's
 * own annotations can only tighten a decision. This module only keeps the
 * list tidy.
 */
import type { McpBindingId, PolicyRule } from '@salvations/core';
import { randomBytes } from 'node:crypto';

export const newRuleId = (): string => `rule_${randomBytes(6).toString('base64url')}`;

/** Any connection, as a rule stores it. */
export const ANY_BINDING = '*';

const sameTarget = (a: PolicyRule, bindingId: string, pattern: string): boolean =>
  (a.bindingId ?? ANY_BINDING) === bindingId && a.capabilityPattern === pattern;

/**
 * Allows one tool on one connection from now on.
 *
 * Replaces a rule already aimed at exactly that tool and connection, so
 * pressing "do not ask again" twice leaves one rule, and a rule that said
 * ask or deny for it is overturned by the person's newer decision.
 */
export function rememberAllow(
  rules: readonly PolicyRule[],
  bindingId: string,
  capabilityName: string,
): PolicyRule[] {
  const kept = rules.filter((rule) => !sameTarget(rule, bindingId, capabilityName));
  const remembered: PolicyRule = {
    id: newRuleId(),
    bindingId: bindingId as McpBindingId,
    capabilityPattern: capabilityName,
    effect: 'allow',
    // Above the editor's default, below anything a person set higher on
    // purpose: a remembered click should not outrank a considered rule.
    priority: 50,
  };
  return [...kept, remembered];
}

/** The editor's defaults for a rule somebody just added. */
export const DEFAULT_RULE_PRIORITY = 10;
