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

/** The one rule that says "everything, for a while". One per scope, by id. */
export const AUTO_APPROVE_RULE_ID = 'auto_approve_window';

/** Above anything the editor writes by hand, below nothing: a deny still wins, by the engine's rule. */
const AUTO_APPROVE_PRIORITY = 900;

/**
 * Replaces the window with one that ends at `until`. Every other rule is
 * left as it is, so switching the window on and off never touches what a
 * person wrote.
 */
export function withAutoApproveWindow(rules: readonly PolicyRule[], until: Date): PolicyRule[] {
  return [
    ...withoutAutoApproveWindow(rules),
    { id: AUTO_APPROVE_RULE_ID, bindingId: ANY_BINDING, capabilityPattern: '*', effect: 'allow', priority: AUTO_APPROVE_PRIORITY, expiresAt: until },
  ];
}

export const withoutAutoApproveWindow = (rules: readonly PolicyRule[]): PolicyRule[] =>
  rules.filter((rule) => rule.id !== AUTO_APPROVE_RULE_ID);

/** When the window closes, if one is open at `now`. */
export function autoApproveUntil(rules: readonly PolicyRule[], now = new Date()): Date | undefined {
  const window = rules.find((rule) => rule.id === AUTO_APPROVE_RULE_ID);
  if (window?.expiresAt === undefined || window.expiresAt.getTime() <= now.getTime()) return undefined;
  return window.expiresAt;
}

/** Rules still in force: the engine skips an ended one, and so does the editor. */
export const liveRules = (rules: readonly PolicyRule[], now = new Date()): PolicyRule[] =>
  rules.filter((rule) => rule.expiresAt === undefined || rule.expiresAt.getTime() > now.getTime());
