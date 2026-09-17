/**
 * ScopedDb — the only way application code touches MongoDB.
 *
 * Every filter is merged with the workspace, every insert stamped, every
 * aggregation gated. Combined with the command-monitoring guard, an unscoped
 * query is caught even if this layer is bypassed. See docs/DATA-MODEL.md §0.3.
 */
import type {
  Collection, Db, Document, Filter, FindOptions, OptionalUnlessRequiredId,
  UpdateFilter, UpdateOptions, WithoutId,
} from 'mongodb';
import { isTenantCollection, type CollectionName } from './collections';
import { PLATFORM_MARKER } from './guard';

export interface TenantDocument extends Document {
  workspaceId: string;
}

export class ScopeViolationError extends Error {
  constructor(detail: string) {
    super(
      `${detail} The scope already determines the workspace, so naming it in a scoped ` +
        'call is either a bug or an attempt to reach another tenant. Silently rewriting ' +
        'it would hide both.',
    );
    this.name = 'ScopeViolationError';
  }
}

/**
 * Merges the workspace into a caller-supplied filter.
 *
 * A caller that specifies workspaceId is REJECTED rather than overridden. There
 * is no legitimate reason for a scoped query to name a workspace — the scope
 * has already fixed it — so an override would quietly turn a forged filter into
 * a successful read of the caller's own data and leave the bug in place.
 */
const scopeFilter = <T extends TenantDocument>(
  workspaceId: string,
  filter: Filter<T> = {},
): Filter<T> => {
  if (Object.prototype.hasOwnProperty.call(filter, 'workspaceId')) {
    throw new ScopeViolationError('Filter must not specify workspaceId.');
  }
  return { ...filter, workspaceId } as Filter<T>;
};

/**
 * Inserts are more forgiving than filters: round-tripping a document read from
 * this same scope legitimately carries its workspaceId. A MATCHING value is
 * accepted and a mismatching one is rejected, so forging stays loud without
 * making read-modify-write awkward.
 */
const scopeInsert = <T extends TenantDocument>(
  workspaceId: string,
  doc: Record<string, unknown>,
): T => {
  const claimed = doc['workspaceId'];
  if (claimed !== undefined && claimed !== workspaceId) {
    throw new ScopeViolationError(
      `Document claims workspace ${String(claimed)} but the scope is ${workspaceId}.`,
    );
  }
  return { ...doc, workspaceId } as unknown as T;
};

export class ScopedCollection<T extends TenantDocument> {
  readonly #collection: Collection<T>;
  readonly #workspaceId: string;

  constructor(collection: Collection<T>, workspaceId: string) {
    this.#collection = collection;
    this.#workspaceId = workspaceId;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  async findOne(filter: Filter<T> = {}, options?: FindOptions): Promise<T | null> {
    return (await this.#collection.findOne(scopeFilter(this.#workspaceId, filter), options)) as T | null;
  }

  async find(filter: Filter<T> = {}, options?: FindOptions): Promise<T[]> {
    return (await this.#collection.find(scopeFilter(this.#workspaceId, filter), options).toArray()) as T[];
  }

  async countDocuments(filter: Filter<T> = {}): Promise<number> {
    return await this.#collection.countDocuments(scopeFilter(this.#workspaceId, filter));
  }

  async insertOne(doc: Omit<T, 'workspaceId'> & Partial<Pick<T, 'workspaceId'>>): Promise<T> {
    const stamped = scopeInsert<T>(this.#workspaceId, doc as Record<string, unknown>);
    await this.#collection.insertOne(stamped as OptionalUnlessRequiredId<T>);
    return stamped;
  }

  async insertMany(docs: readonly (Omit<T, 'workspaceId'> & Partial<Pick<T, 'workspaceId'>>)[]): Promise<T[]> {
    if (docs.length === 0) return [];
    const stamped = docs.map((d) => scopeInsert<T>(this.#workspaceId, d as Record<string, unknown>));
    await this.#collection.insertMany(stamped as OptionalUnlessRequiredId<T>[]);
    return stamped;
  }

  async updateOne(filter: Filter<T>, update: UpdateFilter<T>, options?: UpdateOptions) {
    return await this.#collection.updateOne(scopeFilter(this.#workspaceId, filter), update, options ?? {});
  }

  async updateMany(filter: Filter<T>, update: UpdateFilter<T>, options?: UpdateOptions) {
    return await this.#collection.updateMany(scopeFilter(this.#workspaceId, filter), update, options ?? {});
  }

  async findOneAndUpdate(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options: { returnDocument?: 'before' | 'after'; upsert?: boolean } = {},
  ): Promise<T | null> {
    const result = await this.#collection.findOneAndUpdate(
      scopeFilter(this.#workspaceId, filter),
      update,
      { returnDocument: options.returnDocument ?? 'after', upsert: options.upsert ?? false },
    );
    return result as T | null;
  }

  async deleteOne(filter: Filter<T>) {
    return await this.#collection.deleteOne(scopeFilter(this.#workspaceId, filter));
  }

  async deleteMany(filter: Filter<T>) {
    return await this.#collection.deleteMany(scopeFilter(this.#workspaceId, filter));
  }

  /**
   * Aggregations are gated by a prepended $match, so a pipeline can never begin
   * with a stage that reaches data before the tenant is fixed.
   *
   * $vectorSearch and $search are rejected here: neither is constrained by an
   * upstream $match, so they must be issued through a dedicated search method
   * that places the tenant filter inside the stage (Phase 2).
   */
  async aggregate<R extends Document = Document>(pipeline: readonly Document[]): Promise<R[]> {
    const first = pipeline[0];
    if (first !== undefined) {
      for (const stage of ['$search', '$vectorSearch', '$searchMeta']) {
        if (Object.prototype.hasOwnProperty.call(first, stage)) {
          throw new Error(
            `${stage} cannot be tenant-gated by a prepended $match — the filter must sit inside ` +
              'the stage. Use the dedicated search API. See docs/SECURITY.md §4.2 C3.',
          );
        }
      }
    }
    const gated = [{ $match: { workspaceId: this.#workspaceId } }, ...pipeline];
    return await this.#collection.aggregate<R>(gated).toArray();
  }

  /** Change stream scoped to this workspace — the SSE event bus builds on this. */
  watch(pipeline: readonly Document[] = [], options: { resumeAfter?: unknown } = {}) {
    const gated = [
      { $match: { 'fullDocument.workspaceId': this.#workspaceId } },
      ...pipeline,
    ];
    return this.#collection.watch(gated, {
      fullDocument: 'updateLookup',
      ...(options.resumeAfter !== undefined ? { resumeAfter: options.resumeAfter } : {}),
    });
  }
}

export class ScopedDb {
  readonly #db: Db;
  readonly #workspaceId: string;

  constructor(db: Db, workspaceId: string) {
    this.#db = db;
    this.#workspaceId = workspaceId;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  collection<T extends TenantDocument>(name: CollectionName): ScopedCollection<T> {
    if (!isTenantCollection(name)) {
      throw new Error(
        `"${name}" is not a tenant-scoped collection. Global and mixed collections are reached ` +
          'through their own repositories, not ScopedDb.',
      );
    }
    return new ScopedCollection<T>(this.#db.collection<T>(name), this.#workspaceId);
  }
}

/**
 * Deliberate cross-workspace access.
 *
 * Every command issued here carries the platform marker, so the exemption is
 * explicit, greppable, and visible in the database profiler. Reserved for
 * queue claiming, the stalled-lease sweeper, migrations and platform catalog
 * reads — each one named.
 */
export type PlatformReason =
  | 'queue-claim'
  | 'queue-sweep'
  | 'migration'
  | 'catalog-read'
  | 'index-sync'
  /**
   * "Which workspaces does this user belong to?" is scoped by USER, not by
   * workspace, so it cannot carry a workspaceId filter. It is narrow and
   * legitimate — and it has to say so rather than slip past the guard.
   */
  | 'user-workspaces'
  /**
   * Resolving a chat connection from an inbound delivery.
   *
   * A webhook URL carries a connection id and nothing else — the platform has
   * no idea what a workspace is, and putting one in the URL would leak the
   * tenant boundary to anyone who saw it. So this read finds the row first and
   * scopes everything after it to the workspace the row names.
   */
  | 'channel-delivery'
  /** Resolving an API key by its prefix, before any workspace is known. */
  | 'api-key-lookup';

export class PlatformDb {
  readonly #db: Db;
  readonly #reason: PlatformReason;

  constructor(db: Db, reason: PlatformReason) {
    this.#db = db;
    this.#reason = reason;
  }

  /** The comment the guard recognises. Present on every command from this handle. */
  get comment(): { salvations: string } {
    return { salvations: `platform:${this.#reason}` };
  }

  collection<T extends Document>(name: CollectionName): Collection<T> {
    return this.#db.collection<T>(name);
  }

  get marker(): string {
    return PLATFORM_MARKER;
  }
}

export type { WithoutId };
