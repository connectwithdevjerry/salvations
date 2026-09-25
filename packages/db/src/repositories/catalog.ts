/**
 * Agents, provider configurations and model bindings.
 *
 * An agent references a model ROLE; the workspace maps roles to bindings. That
 * indirection is what makes switching vendor a configuration change rather than
 * an edit to every agent.
 */
import type { Db } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import type { AgentDoc, TenantDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

export interface ProviderConfigDoc extends TenantDoc {
  providerType: string;
  name: string;
  credentialId?: string | null;
  baseUrl?: string | null;
  settings: Record<string, unknown>;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  /**
   * The vendor's last verdict on the stored key. Absent for a key stored
   * before keys were checked, which is exactly the case the UI must not call
   * "connected".
   */
  lastCheck?: ProviderCheck | null;
}

export interface ProviderCheck {
  at: Date;
  ok: boolean;
  message?: string | null;
}

export interface ModelBindingDoc extends TenantDoc {
  providerConfigId: string;
  modelId: string;
  displayName: string;
  role: string;
  params: Record<string, unknown>;
  capabilities?: Record<string, unknown> | null;
  capabilitiesFetchedAt?: Date | null;
  cost: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number };
  fallbackBindingId?: string | null;
  enabled: boolean;
}

export class AgentRepository {
  readonly #agents: ScopedCollection<AgentDoc>;

  constructor(db: Db, workspaceId: string) {
    this.#agents = new ScopedDb(db, workspaceId).collection<AgentDoc>('agents');
  }

  findById(agentId: string): Promise<AgentDoc | null> {
    return this.#agents.findOne({ _id: agentId } as never);
  }

  findBySlug(slug: string): Promise<AgentDoc | null> {
    return this.#agents.findOne({ slug, isArchived: false } as never);
  }

  list(): Promise<AgentDoc[]> {
    return this.#agents.find({ isArchived: false } as never, { sort: { updatedAt: -1 } });
  }

  async create(input: {
    slug: string;
    name: string;
    description?: string;
    category?: string | undefined;
    color?: string | undefined;
    systemPrompt: string;
    modelRole: string;
    createdBy: string;
  }): Promise<AgentDoc> {
    const now = new Date();
    return this.#agents.insertOne({
      _id: newId(IdPrefix.agent),
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      category: input.category ?? null,
      color: input.color ?? null,
      currentVersion: {
        versionId: newId(IdPrefix.agentVersion),
        version: 1,
        systemPrompt: input.systemPrompt,
        modelRole: input.modelRole,
        capabilityBindings: [],
        guardrails: { maxToolCallsPerTurn: 6 },
      },
      isArchived: false,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    } as never);
  }

  /**
   * Changes what an agent is CALLED and where it is FILED.
   *
   * Not a version: none of this reaches a run. A rename or a move between
   * categories must not archive a version and invalidate nothing.
   */
  async setMeta(
    agentId: string,
    meta: {
      name?: string; description?: string; category?: string | null; color?: string | null;
      modelBindingId?: string | null;
    },
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (meta.name !== undefined) set['name'] = meta.name;
    if (meta.description !== undefined) set['description'] = meta.description;
    if (meta.category !== undefined) set['category'] = meta.category;
    if (meta.color !== undefined) set['color'] = meta.color;
    if (meta.modelBindingId !== undefined) set['modelBindingId'] = meta.modelBindingId;
    await this.#agents.updateOne({ _id: agentId } as never, { $set: set } as never);
  }

  /**
   * Renames a group: every live agent in it moves to the new name in one
   * write. A group is nothing but the agents that name it, so this is the
   * whole operation. Returns how many moved.
   */
  async renameCategory(from: string, to: string): Promise<number> {
    const result = await this.#agents.updateMany(
      { category: from, isArchived: false } as never,
      { $set: { category: to, updatedAt: new Date() } } as never,
    );
    return result.modifiedCount;
  }

  /** How many live agents there are — the avatar palette rotates on it. */
  async count(): Promise<number> {
    return this.#agents.countDocuments({ isArchived: false } as never);
  }

  /**
   * Publishes a new version.
   *
   * The previous version is archived to agentVersions before the agent is
   * updated, so a run that pinned it stays reproducible after an edit.
   */
  async publishVersion(
    db: Db,
    workspaceId: string,
    agentId: string,
    snapshot: AgentDoc['currentVersion'],
    changelog: string,
    createdBy: string,
  ): Promise<void> {
    const current = await this.findById(agentId);
    if (current === null) throw new Error(`Agent ${agentId} not found.`);

    const versions = new ScopedDb(db, workspaceId).collection<TenantDoc>('agentVersions');
    await versions.insertOne({
      _id: current.currentVersion.versionId,
      agentId,
      version: current.currentVersion.version,
      snapshot: current.currentVersion,
      changelog,
      createdBy,
      createdAt: new Date(),
    } as never);

    await this.#agents.updateOne(
      { _id: agentId } as never,
      {
        $set: {
          currentVersion: {
            ...snapshot,
            versionId: newId(IdPrefix.agentVersion),
            version: current.currentVersion.version + 1,
          },
          updatedAt: new Date(),
        },
      } as never,
    );
  }
}

export class ModelBindingRepository {
  readonly #bindings: ScopedCollection<ModelBindingDoc>;
  readonly #providers: ScopedCollection<ProviderConfigDoc>;

  constructor(db: Db, workspaceId: string) {
    const scoped = new ScopedDb(db, workspaceId);
    this.#bindings = scoped.collection<ModelBindingDoc>('modelBindings');
    this.#providers = scoped.collection<ProviderConfigDoc>('providerConfigs');
  }

  /** Resolves a role to its binding — the vendor-swap point. */
  forRole(role: string): Promise<ModelBindingDoc | null> {
    return this.#bindings.findOne({ role, enabled: true } as never);
  }

  findById(bindingId: string): Promise<ModelBindingDoc | null> {
    return this.#bindings.findOne({ _id: bindingId } as never);
  }

  list(): Promise<ModelBindingDoc[]> {
    return this.#bindings.find({} as never);
  }

  providerFor(binding: ModelBindingDoc): Promise<ProviderConfigDoc | null> {
    return this.#providers.findOne({ _id: binding.providerConfigId } as never);
  }

  listProviders(): Promise<ProviderConfigDoc[]> {
    return this.#providers.find({} as never);
  }

  async createProvider(input: Omit<ProviderConfigDoc, '_id' | 'workspaceId'>): Promise<ProviderConfigDoc> {
    return this.#providers.insertOne({ _id: newId(IdPrefix.providerConfig), ...input } as never);
  }

  findProvider(providerId: string): Promise<ProviderConfigDoc | null> {
    return this.#providers.findOne({ _id: providerId } as never);
  }

  async recordCheck(providerId: string, check: ProviderCheck): Promise<void> {
    await this.#providers.updateOne(
      { _id: providerId } as never,
      { $set: { lastCheck: check } } as never,
    );
  }

  /**
   * Removes a provider and every binding that pointed at it.
   *
   * The bindings go too: a binding whose provider is gone is a role that
   * resolves and then fails at the first call, which is worse than a role
   * that visibly has nothing bound.
   */
  async removeProvider(providerId: string): Promise<{ removed: boolean; bindings: number }> {
    const bindings = await this.#bindings.deleteMany({ providerConfigId: providerId } as never);
    const removed = await this.#providers.deleteOne({ _id: providerId } as never);
    return { removed: removed.deletedCount === 1, bindings: bindings.deletedCount };
  }

  async createBinding(input: Omit<ModelBindingDoc, '_id' | 'workspaceId'>): Promise<ModelBindingDoc> {
    return this.#bindings.insertOne({ _id: newId(IdPrefix.modelBinding), ...input } as never);
  }

  /** Caches a capability descriptor so the runtime reads data, not a live call. */
  async cacheCapabilities(
    bindingId: string,
    capabilities: Record<string, unknown>,
  ): Promise<void> {
    await this.#bindings.updateOne(
      { _id: bindingId } as never,
      { $set: { capabilities, capabilitiesFetchedAt: new Date() } } as never,
    );
  }
}
