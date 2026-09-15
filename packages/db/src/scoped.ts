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
import { isTenantCollection, type CollectionName } from './collections.js';
import { PLATFORM_MARKER } from './guard.js';

export interface TenantDocument extends Document {
  workspaceId: string;
}

/** Merges the workspace into any caller-supplied filter. */
const scopeFilter = <T extends TenantDocument>(
  workspaceId: string,
  filter: Filter<T> = {},
): Filter<T> => ({ ...filter, workspaceId } as Filter<T>);

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

  findOne(filter: Filter<T> = {}, options?: FindOptions): Promise<T | null> {
    return this.#collection.findOne(scopeFilter(this.#workspaceId, filter), options) as Promise<T | null>;
  }

  find(filter: Filter<T> = {}, options?: FindOptions): Promise<T[]> {
    return this.#collection.find(scopeFilter(this.#workspaceId, filter), options).toArray() as Promise<T[]>;
  }

  countDocuments(filter: Filter<T> = {}): Promise<number> {
    return this.#collection.countDocuments(scopeFilter(this.#workspaceId, filter));
  }

  async insertOne(doc: Omit<T, 'workspaceId'> & Partial<Pick<T, 'workspaceId'>>): Promise<T> {
    // Stamped here rather than trusted from the caller: a caller that forgot is
    // exactly the case this layer exists to make impossible.
    const stamped = { ...doc, workspaceId: this.#workspaceId } as unknown as T;
    await this.#collection.insertOne(stamped as OptionalUnlessRequiredId<T>);
    return stamped;
  }

  async insertMany(docs: readonly (Omit<T, 'workspaceId'> & Partial<Pick<T, 'workspaceId'>>)[]): Promise<T[]> {
    if (docs.length === 0) return [];
    const stamped = docs.map((d) => ({ ...d, workspaceId: this.#workspaceId }) as unknown as T);
    await this.#collection.insertMany(stamped as OptionalUnlessRequiredId<T>[]);
    return stamped;
  }

  updateOne(filter: Filter<T>, update: UpdateFilter<T>, options?: UpdateOptions) {
    return this.#collection.updateOne(scopeFilter(this.#workspaceId, filter), update, options ?? {});
  }

  updateMany(filter: Filter<T>, update: UpdateFilter<T>, options?: UpdateOptions) {
    return this.#collection.updateMany(scopeFilter(this.#workspaceId, filter), update, options ?? {});
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

  deleteOne(filter: Filter<T>) {
    return this.#collection.deleteOne(scopeFilter(this.#workspaceId, filter));
  }

  deleteMany(filter: Filter<T>) {
    return this.#collection.deleteMany(scopeFilter(this.#workspaceId, filter));
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
  | 'index-sync';

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
