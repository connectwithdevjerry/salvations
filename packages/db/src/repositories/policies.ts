/**
 * Policy documents — one per scope, each holding its rules inline.
 *
 * A permission decision needs every rule that applies, so the shape is chosen
 * to make that at most three reads (workspace, agent, principal) rather than a
 * query per rule.
 */
import type { Db } from 'mongodb';
import type { PolicyDocument, PolicyRule, PolicyScopeType } from '@salvations/core';
import { asId } from '@salvations/core';
import type { PolicyId, WorkspaceId } from '@salvations/core';
import type { PolicyDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

export interface ScopeRef {
  readonly type: PolicyScopeType;
  readonly id?: string;
}

export class PolicyRepository {
  readonly #collection: ScopedCollection<PolicyDoc>;
  readonly #workspaceId: string;

  constructor(db: Db, workspaceId: string) {
    this.#collection = new ScopedDb(db, workspaceId).collection<PolicyDoc>('policies');
    this.#workspaceId = workspaceId;
  }

  /**
   * Loads every policy that applies, in one query.
   *
   * Missing documents are simply absent rather than an error: a workspace with
   * no policies falls through to its default effect, which ships as `ask`.
   */
  async loadForDecision(scopes: readonly ScopeRef[]): Promise<PolicyDocument[]> {
    if (scopes.length === 0) return [];
    const docs = await this.#collection.find({
      $or: scopes.map((s) => ({
        scopeType: s.type,
        scopeId: s.id ?? null,
      })),
    } as never);
    return docs.map((d) => this.#toDomain(d));
  }

  async get(scope: ScopeRef): Promise<PolicyDocument | null> {
    const doc = await this.#collection.findOne({
      scopeType: scope.type,
      scopeId: scope.id ?? null,
    } as never);
    return doc === null ? null : this.#toDomain(doc);
  }

  async setRules(scope: ScopeRef, rules: readonly PolicyRule[], updatedBy: string): Promise<void> {
    await this.#collection.updateOne(
      { scopeType: scope.type, scopeId: scope.id ?? null } as never,
      {
        $set: { rules: [...rules], updatedBy, updatedAt: new Date() },
        $setOnInsert: { _id: `pol_${scope.type}_${scope.id ?? 'all'}` },
      } as never,
      { upsert: true },
    );
  }

  #toDomain(doc: PolicyDoc): PolicyDocument {
    return {
      id: asId<PolicyId>(doc._id),
      workspaceId: asId<WorkspaceId>(this.#workspaceId),
      scopeType: doc.scopeType as PolicyScopeType,
      ...(doc.scopeId !== null && doc.scopeId !== undefined ? { scopeId: doc.scopeId } : {}),
      rules: (doc.rules ?? []) as PolicyRule[],
    };
  }
}
