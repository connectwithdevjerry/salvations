/**
 * The data-loading half of the permission broker.
 *
 * Every DECISION is made by `decidePermission` in @salvations/core, which is
 * pure and exhaustively tested. This class only assembles its inputs: the
 * capability at its current definition hash, the policy documents for each
 * applicable scope, the binding's trust tier, and how many times this
 * capability has already been called in the run.
 *
 * Keeping the decision pure is what lets the security rules be tested without a
 * database, and keeping the loading here is what keeps the runtime free of data
 * access. See docs/SECURITY.md §3.3.
 */
import type { Db } from 'mongodb';
import {
  decidePermission,
  type McpCapability,
  type PermissionDecision,
  type PolicyScopeType,
  type Principal,
  type TrustTier,
} from '@salvations/core';
import { capabilityToDomain } from '../repositories/capability-mapper';
import { PolicyRepository, type ScopeRef } from '../repositories/policies';
import { ScopedDb } from '../scoped';
import type { McpCapabilityDoc, McpServerBindingDoc, WorkspaceDoc } from '../documents';

export interface BrokerInput {
  readonly principal: Principal;
  readonly agentId?: string;
  readonly bindingId: string;
  readonly scopeKey: string;
  readonly capabilityName: string;
  readonly args: unknown;
  readonly callsThisRun: number;
}

export interface BrokerOutcome extends PermissionDecision {
  readonly capability?: McpCapability;
}

/** Scopes contributing rules, ordered workspace -> agent -> principal. */
export function scopesFor(input: BrokerInput): ScopeRef[] {
  const scopes: ScopeRef[] = [{ type: 'workspace' }];
  if (input.agentId !== undefined) scopes.push({ type: 'agent', id: input.agentId });

  const principal = input.principal;
  const actor = principal.type === 'agent' ? principal.onBehalfOf : principal;
  const principalScope: { type: PolicyScopeType; id: string } | undefined =
    actor.type === 'user' ? { type: 'member', id: actor.userId }
    : actor.type === 'api_key' ? { type: 'apiKey', id: actor.apiKeyId }
    : actor.type === 'channel_identity' ? { type: 'channel', id: actor.identityId }
    : undefined;
  if (principalScope !== undefined) scopes.push(principalScope);

  return scopes;
}

export class MongoPermissionBroker {
  readonly #db: Db;
  readonly #workspaceId: string;

  constructor(db: Db, workspaceId: string) {
    this.#db = db;
    this.#workspaceId = workspaceId;
  }

  async decide(input: BrokerInput): Promise<BrokerOutcome> {
    const scoped = new ScopedDb(this.#db, this.#workspaceId);

    const capDoc = await scoped
      .collection<McpCapabilityDoc>('mcpCapabilities')
      .findOne({
        bindingId: input.bindingId,
        scopeKey: input.scopeKey,
        name: input.capabilityName,
      } as never);

    if (capDoc === null) {
      // An unknown capability is denied, not an error: the model must learn it
      // was refused rather than receive nothing and retry.
      return { effect: 'deny', reason: 'unknown_capability', tightenedByFloor: false };
    }

    const capability = capabilityToDomain(capDoc);

    const [policies, trustTier, defaultEffect] = await Promise.all([
      new PolicyRepository(this.#db, this.#workspaceId).loadForDecision(scopesFor(input)),
      this.#trustTierOf(input.bindingId),
      this.#defaultEffect(),
    ]);

    const decision = decidePermission({
      capability,
      bindingId: capability.bindingId,
      trustTier,
      args: input.args,
      policies,
      defaultEffect,
      callsThisRun: input.callsThisRun,
    });

    return { ...decision, capability };
  }

  /**
   * A binding whose server definition cannot be read is treated as untrusted —
   * the most restrictive tier, not the most permissive.
   */
  async #trustTierOf(bindingId: string): Promise<TrustTier> {
    const scoped = new ScopedDb(this.#db, this.#workspaceId);
    const binding = await scoped
      .collection<McpServerBindingDoc>('mcpServerBindings')
      .findOne({ _id: bindingId } as never);
    if (binding === null) return 'untrusted';

    const server = await this.#db
      .collection<{ _id: string; trustTier?: string }>('mcpServers')
      .findOne(
        { _id: binding.mcpServerId },
        { comment: { salvations: 'platform:catalog-read' } },
      );
    return (server?.trustTier as TrustTier | undefined) ?? 'untrusted';
  }

  /** Fails closed: an unreadable or unset workspace default is `ask`. */
  async #defaultEffect(): Promise<'allow' | 'ask' | 'deny'> {
    const scoped = new ScopedDb(this.#db, this.#workspaceId);
    const workspace = await scoped
      .collection<WorkspaceDoc>('workspaces')
      .findOne({ _id: this.#workspaceId } as never, { projection: { settings: 1 } });
    return workspace?.settings?.defaultToolEffect ?? 'ask';
  }
}
