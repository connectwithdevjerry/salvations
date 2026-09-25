/**
 * Capability discovery.
 *
 * Under 2026-07-28 there is no `initialize` handshake to tell us what a server
 * offers. `server/discover` advertises protocol versions and capabilities, and
 * the list verbs enumerate the actual tools — each returning `ttlMs` and
 * `cacheScope` (SEP-2549), which this module treats as a tenancy signal rather
 * than a performance hint.
 *
 * Nothing here decides whether a capability may be USED. Discovery says what
 * exists; approval and permission say what may be called, and both live behind
 * the gateway.
 */
import type { Client } from '@modelcontextprotocol/client';
import { canonicalCapabilityName, type DiscoveredCapability } from '@salvations/core';
import { ScopedResponseCache, clampTtl, parseCacheScope, type CacheScope } from './cache';
import type { McpServerDefinition } from './client';
import type { ConnectOptions, McpClientManager } from './client';
import { capabilityScopeKey, type ConnectionScopeKey } from './scope';

/** What one discovery pass learned. */
export interface DiscoveryOutcome {
  readonly capabilities: readonly DiscoveredCapability[];
  /** `workspace` or `user:<id>` — the value stored on each capability row. */
  readonly scopeKey: string;
  readonly protocolEra: 'modern' | 'legacy' | 'unknown';
  readonly negotiatedProtocolVersion?: string;
  readonly instructions?: string;
  /** Clamped. Zero means the server did not authorise caching. */
  readonly ttlMs: number;
  readonly cacheScope: CacheScope;
  readonly servedFromCache: boolean;
  /** Verbs the server refused or does not implement, so an operator can see why
   *  a binding came back thin instead of guessing. */
  readonly skipped: readonly { readonly verb: string; readonly reason: string }[];
}

export interface DiscoveryOptions {
  /** Ignores any cached result. Used after a reconnect or a re-auth. */
  readonly refresh?: boolean;
  /**
   * Passed through to the connection.
   *
   * Needed because discovery opens the connection itself: a first-party server
   * that could be CALLED but not DISCOVERED would have no capabilities, and so
   * nothing callable.
   */
  readonly connect?: ConnectOptions;
  /** Prompts and resources are discovered too, but only tools matter in Phase 1. */
  readonly kinds?: readonly ('tool' | 'prompt' | 'resource' | 'resource_template')[];
}

const DEFAULT_KINDS = ['tool'] as const;

/** The cache method key. Discovery is cached as a whole, not verb by verb: a
 *  half-fresh tool surface is harder to reason about than a refetch. */
const CACHE_METHOD = 'salvations/discovery';

interface Cacheable {
  readonly ttlMs?: unknown;
  readonly cacheScope?: unknown;
}

/**
 * Combines the freshness metadata of several list results.
 *
 * The SHORTEST TTL and the LEAST shareable scope win. Combining them any other
 * way would let one generous verb extend the life, or widen the audience, of a
 * stricter one.
 */
function combine(results: readonly Cacheable[]): { ttlMs: number; cacheScope: CacheScope } {
  let ttlMs = Number.POSITIVE_INFINITY;
  let cacheScope: CacheScope = 'public';

  for (const result of results) {
    ttlMs = Math.min(ttlMs, clampTtl(result.ttlMs));
    const scope = parseCacheScope(result.cacheScope);
    if (scope !== 'public') cacheScope = scope === 'private' ? 'private' : 'unknown';
  }

  return {
    ttlMs: Number.isFinite(ttlMs) ? ttlMs : 0,
    // No results at all is not a licence to share.
    cacheScope: results.length === 0 ? 'unknown' : cacheScope,
  };
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

export class CapabilityDiscovery {
  readonly #manager: McpClientManager;
  readonly #cache: ScopedResponseCache;

  constructor(manager: McpClientManager, cache: ScopedResponseCache = new ScopedResponseCache()) {
    this.#manager = manager;
    this.#cache = cache;
  }

  /**
   * Enumerates what a binding offers, for one scope.
   *
   * The scope is not optional and not inferred: a per-user binding shows a
   * different tool surface to every user, and a result discovered for one must
   * never be handed to another.
   */
  async discover(
    definition: McpServerDefinition,
    scope: ConnectionScopeKey,
    options: DiscoveryOptions = {},
  ): Promise<DiscoveryOutcome> {
    if (options.refresh !== true) {
      const cached = this.#cache.get<DiscoveryOutcome>(scope, CACHE_METHOD);
      if (cached !== undefined) return { ...cached, servedFromCache: true };
    }

    const outcome = await this.#manager.run(
      definition,
      scope,
      (client) => this.#collect(client, definition, scope, options.kinds ?? DEFAULT_KINDS),
      options.connect ?? {},
    );

    this.#cache.set(scope, CACHE_METHOD, outcome, outcome.ttlMs, outcome.cacheScope);
    return outcome;
  }

  async #collect(
    client: Client,
    definition: McpServerDefinition,
    scope: ConnectionScopeKey,
    kinds: readonly string[],
  ): Promise<DiscoveryOutcome> {
    const capabilities: DiscoveredCapability[] = [];
    const skipped: { verb: string; reason: string }[] = [];
    const cacheables: Cacheable[] = [];

    // `server/discover` already ran during connect for a modern peer; reading
    // the recorded result avoids a second round trip, and its absence is how we
    // know we are talking to a 2025-era server.
    const discover = client.getDiscoverResult();
    if (discover !== undefined) cacheables.push(discover as Cacheable);

    if (kinds.includes('tool')) {
      try {
        // No cursor: the SDK walks the pages itself, up to its own cap.
        const result = await client.listTools();
        cacheables.push(result as Cacheable);
        for (const tool of result.tools ?? []) {
          capabilities.push(toCapability('tool', definition.alias, tool as Record<string, unknown>));
        }
      } catch (error) {
        // A server with no tools capability is normal, not an outage. Failing
        // the whole pass would hide the prompts and resources it does offer.
        skipped.push({ verb: 'tools/list', reason: messageOf(error) });
      }
    }

    if (kinds.includes('prompt')) {
      try {
        const result = await client.listPrompts();
        cacheables.push(result as Cacheable);
        for (const prompt of result.prompts ?? []) {
          capabilities.push(
            toCapability('prompt', definition.alias, prompt as Record<string, unknown>),
          );
        }
      } catch (error) {
        skipped.push({ verb: 'prompts/list', reason: messageOf(error) });
      }
    }

    if (kinds.includes('resource')) {
      try {
        const result = await client.listResources();
        cacheables.push(result as Cacheable);
        for (const resource of result.resources ?? []) {
          capabilities.push(
            toResourceCapability('resource', definition.alias, resource as Record<string, unknown>),
          );
        }
      } catch (error) {
        skipped.push({ verb: 'resources/list', reason: messageOf(error) });
      }
    }

    if (kinds.includes('resource_template')) {
      try {
        const result = await client.listResourceTemplates();
        cacheables.push(result as Cacheable);
        for (const template of result.resourceTemplates ?? []) {
          capabilities.push(
            toResourceCapability(
              'resource_template', definition.alias, template as Record<string, unknown>,
            ),
          );
        }
      } catch (error) {
        skipped.push({ verb: 'resources/templates/list', reason: messageOf(error) });
      }
    }

    const { ttlMs, cacheScope } = combine(cacheables);
    const era = client.getProtocolEra();

    return {
      capabilities,
      scopeKey: capabilityScopeKey(scope),
      protocolEra: era === 'modern' || era === 'legacy' ? era : 'unknown',
      ...(client.getNegotiatedProtocolVersion() !== undefined
        ? { negotiatedProtocolVersion: client.getNegotiatedProtocolVersion() as string }
        : {}),
      ...(client.getInstructions() !== undefined
        ? { instructions: client.getInstructions() as string }
        : {}),
      ttlMs,
      cacheScope,
      servedFromCache: false,
      skipped,
    };
  }

  /** Drops every cached discovery for a binding, in every scope. Called on
   *  reconfiguration and on revocation, where a stale surface is a correctness
   *  problem rather than a slow one. */
  invalidate(workspaceId: string, bindingId: string): number {
    return this.#cache.invalidateBinding(workspaceId, bindingId);
  }
}

function toCapability(
  kind: 'tool' | 'prompt',
  alias: string,
  raw: Record<string, unknown>,
): DiscoveredCapability {
  const name = String(raw['name'] ?? '');
  const title = raw['title'];
  const description = raw['description'];
  const inputSchema = asRecord(raw['inputSchema']);
  const outputSchema = asRecord(raw['outputSchema']);
  const annotations = asRecord(raw['annotations']);

  return {
    kind,
    name,
    canonicalName: canonicalCapabilityName(alias, name),
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
  };
}

/**
 * Resources are addressed by URI, not by name.
 *
 * The URI is what identifies them, so it — not the human-facing title — is the
 * name we key on: two resources may legitimately share a display name.
 */
function toResourceCapability(
  kind: 'resource' | 'resource_template',
  alias: string,
  raw: Record<string, unknown>,
): DiscoveredCapability {
  const uri = String(raw['uri'] ?? raw['uriTemplate'] ?? '');
  const title = raw['title'] ?? raw['name'];
  const description = raw['description'];
  const annotations = asRecord(raw['annotations']);

  return {
    kind,
    name: uri,
    canonicalName: canonicalCapabilityName(alias, uri),
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
