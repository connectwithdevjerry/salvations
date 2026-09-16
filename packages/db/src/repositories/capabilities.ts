/**
 * Capability discovery persistence.
 *
 * The rug-pull defence (docs/SECURITY.md §6.2) lives here. A server can change
 * a tool's schema or description AFTER an admin approved it, and the description
 * enters the model's context — so this is an injection surface as well as a
 * capability change.
 *
 * Because definitionHash and approval.definitionHash live in the SAME document,
 * discovery updates both in one write. There is no window in which a changed
 * tool is still approved, and no cross-document race to reason about.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, type DiscoveredCapability } from '@salvations/core';
import type { McpCapabilityDoc } from '../documents';
import type { ScopedCollection } from '../scoped';

// Defined in the domain: discovery produces it and this repository reconciles
// it, so neither package owns it.
export type { DiscoveredCapability };

// Canonical JSON lives in the domain: the prompt-prefix fingerprint needs the
// identical definition, and two implementations would drift.
export { canonicalJson };

/**
 * Everything the model can see, and everything that changes what a call does.
 *
 * Description and title are included deliberately: they reach the model's
 * context, so a silent rewrite is an injection vector even when the schema is
 * untouched.
 */
export function computeDefinitionHash(cap: DiscoveredCapability): string {
  const material = canonicalJson({
    kind: cap.kind,
    name: cap.name,
    title: cap.title ?? null,
    description: cap.description ?? null,
    inputSchema: cap.inputSchema ?? null,
    outputSchema: cap.outputSchema ?? null,
    annotations: cap.annotations ?? null,
  });
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

export interface DiscoveryDiff {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

export class CapabilityRepository {
  readonly #collection: ScopedCollection<McpCapabilityDoc>;

  constructor(collection: ScopedCollection<McpCapabilityDoc>) {
    this.#collection = collection;
  }

  async listForBinding(bindingId: string, scopeKey: string): Promise<McpCapabilityDoc[]> {
    return this.#collection.find({ bindingId, scopeKey, removedAt: null });
  }

  /**
   * Every live capability for a scope, across bindings.
   *
   * What a run actually needs: an agent's tool surface spans several servers,
   * and asking binding by binding is one round trip per installed server on
   * every single step.
   */
  async listForScope(scopeKeys: readonly string[]): Promise<McpCapabilityDoc[]> {
    return this.#collection.find({ scopeKey: { $in: [...scopeKeys] }, removedAt: null });
  }

  async findByCanonicalName(
    bindingId: string,
    scopeKey: string,
    canonicalName: string,
  ): Promise<McpCapabilityDoc | null> {
    return this.#collection.findOne({ bindingId, scopeKey, canonicalName, removedAt: null });
  }

  /**
   * Reconcile a discovery result.
   *
   * Returns a diff so the caller can emit change events and surface a
   * re-approval prompt with the specific capabilities that moved.
   */
  async reconcile(
    bindingId: string,
    scopeKey: string,
    discovered: readonly DiscoveredCapability[],
    now: Date,
  ): Promise<DiscoveryDiff> {
    const existing = await this.#collection.find({ bindingId, scopeKey });
    const existingByName = new Map(existing.map((d) => [`${d.kind}:${d.name}`, d]));

    const added: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const cap of discovered) {
      const key = `${cap.kind}:${cap.name}`;
      const hash = computeDefinitionHash(cap);
      const prior = existingByName.get(key);
      existingByName.delete(key);

      if (prior === undefined) added.push(cap.canonicalName);
      else if (prior.definitionHash !== hash) changed.push(cap.canonicalName);
      else unchanged.push(cap.canonicalName);

      await this.#upsert(bindingId, scopeKey, cap, hash, now);
    }

    // Anything still in the map was not returned by the server this time.
    const removed: string[] = [];
    for (const stale of existingByName.values()) {
      if (stale.removedAt !== null && stale.removedAt !== undefined) continue;
      removed.push(stale.canonicalName);
      // Soft delete — history must stay explainable after a server changes.
      await this.#collection.updateOne(
        { _id: stale._id },
        { $set: { removedAt: now, lastSeenAt: stale.lastSeenAt } },
      );
    }

    return { added, changed, unchanged, removed };
  }

  async #upsert(
    bindingId: string,
    scopeKey: string,
    cap: DiscoveredCapability,
    hash: string,
    now: Date,
  ): Promise<void> {
    // An aggregation-pipeline update, because approval must be decided FROM the
    // stored hash in the same write that replaces it. Expressions in a $set
    // stage see the pre-update document, so `$definitionHash` is the old value.
    await this.#collection.updateOne(
      { bindingId, scopeKey, kind: cap.kind, name: cap.name },
      [
        {
          $set: {
            bindingId,
            scopeKey,
            kind: cap.kind,
            name: cap.name,
            canonicalName: cap.canonicalName,
            title: cap.title ?? null,
            description: cap.description ?? null,
            inputSchema: cap.inputSchema ?? null,
            outputSchema: cap.outputSchema ?? null,
            annotations: cap.annotations ?? null,
            definitionHash: hash,
            firstSeenAt: { $ifNull: ['$firstSeenAt', now] },
            lastSeenAt: now,
            removedAt: null,
            approval: {
              $cond: [
                { $eq: [{ $ifNull: ['$definitionHash', null] }, hash] },
                // Unchanged: keep the existing approval exactly as it stands.
                { $ifNull: ['$approval', { state: 'pending', definitionHash: hash }] },
                // Changed (or new): force pending, but PRESERVE the previously
                // approved hash and approver so the UI can show a real diff and
                // the audit trail survives.
                {
                  $mergeObjects: [
                    { state: 'pending', definitionHash: hash },
                    { $ifNull: ['$approval', {}] },
                    { state: 'pending' },
                  ],
                },
              ],
            },
          },
        },
      ] as never,
      { upsert: true },
    );
  }

  /** Approve at a specific hash. A concurrent rediscovery makes this a no-op. */
  async approve(capabilityId: string, definitionHash: string, userId: string, now: Date): Promise<boolean> {
    const result = await this.#collection.updateOne(
      // The hash guard matters: between an operator reading the diff and
      // clicking approve, discovery may have moved the capability again.
      { _id: capabilityId, definitionHash },
      { $set: { approval: { state: 'approved', definitionHash, approvedBy: userId, approvedAt: now } } },
    );
    return result.matchedCount === 1;
  }

  async revoke(capabilityId: string): Promise<void> {
    await this.#collection.updateOne(
      { _id: capabilityId },
      { $set: { 'approval.state': 'revoked' } },
    );
  }

  async listPendingApproval(): Promise<McpCapabilityDoc[]> {
    return this.#collection.find({ 'approval.state': 'pending', removedAt: null } as never);
  }
}
