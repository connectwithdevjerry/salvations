/**
 * Discovery response caching.
 *
 * The specification returns `ttlMs` and `cacheScope` on list and read results.
 * `cacheScope` is a TENANCY-SAFETY signal, not a performance hint: it says
 * whether a response may be reused for a different user. Getting it wrong
 * leaks one tenant's tool surface into another's session.
 *
 * Absent or unrecognised therefore means "not shareable" — fail closed. The
 * cost of being wrong in that direction is a cache miss.
 */
import { scopeKeyString, type ConnectionScopeKey } from './scope';

/**
 * Shareability as the specification defines it, plus the value we use when the
 * server said nothing.
 *
 * `private` is the spec's "MUST NOT share across authorization contexts".
 * `unknown` is ours: a server that omitted the field, or a newer value we do
 * not recognise.
 */
export type CacheScope = 'public' | 'private' | 'unknown';

export function parseCacheScope(raw: unknown): CacheScope {
  switch (raw) {
    case 'public': return 'public';
    case 'private': return 'private';
    // An absent field is an older server; an unrecognised one is a newer spec
    // or a broken server. Neither entitles us to assume sharing is safe.
    default: return 'unknown';
  }
}

/**
 * May a response be reused for a different principal in the same workspace?
 *
 * Only an explicit `public` permits it.
 */
export const isShareableAcrossUsers = (scope: CacheScope): boolean => scope === 'public';

/**
 * The key a response is filed under.
 *
 * A shared response is filed under the WORKSPACE even when it was fetched in a
 * user scope, so the next user gets a hit. Anything else keeps the full
 * per-user key, so it can never be served to someone else.
 */
export function cacheKeyFor(
  scope: ConnectionScopeKey,
  method: string,
  cacheScope: CacheScope,
): string {
  const base = isShareableAcrossUsers(cacheScope)
    ? `${scope.workspaceId}|${scope.bindingId}|workspace`
    : scopeKeyString(scope);
  return `${base}|${method}`;
}

/** Upper bound on any server-supplied TTL, so a hostile ttlMs cannot pin stale
 *  capabilities in place indefinitely. */
export const MAX_TTL_MS = 10 * 60 * 1000;

export const clampTtl = (ttlMs: unknown): number => {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return 0;
  return Math.min(ttlMs, MAX_TTL_MS);
};

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
  readonly cacheScope: CacheScope;
}

/**
 * A scope-aware cache.
 *
 * Deliberately simple and in-process: discovery results are also persisted to
 * the capability store, so this is a latency optimisation whose worst failure
 * is a refetch.
 */
export class ScopedResponseCache {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(options: { now?: () => number; maxEntries?: number } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#maxEntries = options.maxEntries ?? 1000;
  }

  get<T>(scope: ConnectionScopeKey, method: string): T | undefined {
    // A read must try BOTH the shared key and the private one: a response may
    // have been filed either way depending on what the server said last time.
    for (const cacheScope of ['public', 'private'] as const) {
      const key = cacheKeyFor(scope, method, cacheScope);
      const entry = this.#entries.get(key);
      if (entry === undefined) continue;
      if (entry.expiresAt <= this.#now()) {
        this.#entries.delete(key);
        continue;
      }
      // A private entry filed under this exact scope is ours; a shared entry is
      // everyone's. Neither can be another user's private entry, because that
      // would be filed under a different key.
      return entry.value as T;
    }
    return undefined;
  }

  set(
    scope: ConnectionScopeKey,
    method: string,
    value: unknown,
    ttlMs: unknown,
    rawCacheScope: unknown,
  ): void {
    const ttl = clampTtl(ttlMs);
    // No TTL means the server did not authorise caching at all.
    if (ttl === 0) return;

    const cacheScope = parseCacheScope(rawCacheScope);
    const key = cacheKeyFor(scope, method, cacheScope);

    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }

    this.#entries.set(key, { value, expiresAt: this.#now() + ttl, cacheScope });
  }

  /** Drops every entry for a binding, in every scope. Used on reconfiguration
   *  and on revocation, where a stale tool surface is a correctness problem. */
  invalidateBinding(workspaceId: string, bindingId: string): number {
    const prefix = `${workspaceId}|${bindingId}|`;
    let removed = 0;
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}
