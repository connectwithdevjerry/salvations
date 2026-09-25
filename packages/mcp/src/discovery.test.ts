import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { McpClientManager, type McpServerDefinition } from './client';
import { CapabilityDiscovery } from './discovery';
import { ScopedResponseCache } from './cache';
import { userScope, workspaceScope, type ConnectionScopeKey } from './scope';

const DEFINITION: McpServerDefinition = {
  bindingId: 'bnd_1',
  serverId: 'srv_1',
  alias: 'calendar',
  transport: 'streamable_http',
  url: 'https://example.test/mcp',
};

interface FakeServer {
  readonly tools?: Record<string, unknown>[];
  readonly prompts?: Record<string, unknown>[];
  readonly resources?: Record<string, unknown>[];
  readonly ttlMs?: number;
  readonly cacheScope?: unknown;
  readonly discoverTtlMs?: number;
  readonly era?: 'modern' | 'legacy';
  readonly toolsThrow?: Error;
}

/** Answers per scope, so one manager can serve two users differently. */
class FakeManager extends McpClientManager {
  calls = 0;
  readonly #byScope: (scope: ConnectionScopeKey) => FakeServer;

  constructor(byScope: FakeServer | ((scope: ConnectionScopeKey) => FakeServer)) {
    super();
    this.#byScope = typeof byScope === 'function' ? byScope : () => byScope;
  }

  override async run<T>(
    _definition: McpServerDefinition,
    scope: ConnectionScopeKey,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    this.calls += 1;
    const server = this.#byScope(scope);
    const cacheable = {
      ttlMs: server.ttlMs ?? 60_000,
      cacheScope: server.cacheScope ?? 'private',
    };

    const client = {
      getDiscoverResult: () =>
        server.era === 'legacy'
          ? undefined
          : { ...cacheable, ttlMs: server.discoverTtlMs ?? cacheable.ttlMs, supportedVersions: ['2026-07-28'], capabilities: {} },
      getProtocolEra: () => server.era ?? 'modern',
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getInstructions: () => undefined,
      listTools: async () => {
        if (server.toolsThrow !== undefined) throw server.toolsThrow;
        return { ...cacheable, tools: server.tools ?? [] };
      },
      listPrompts: async () => ({ ...cacheable, prompts: server.prompts ?? [] }),
      listResources: async () => ({ ...cacheable, resources: server.resources ?? [] }),
      listResourceTemplates: async () => ({ ...cacheable, resourceTemplates: [] }),
    };

    return operation(client as unknown as Client);
  }
}

const TOOL = {
  name: 'create_event',
  title: 'Create event',
  description: 'Creates a calendar event.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  annotations: { readOnlyHint: false },
};

describe('enumeration', () => {
  it('namespaces every capability under the binding alias', async () => {
    // The alias is unique per workspace, which is what makes canonical names
    // collision-free without a registry lookup.
    const discovery = new CapabilityDiscovery(new FakeManager({ tools: [TOOL] }));
    const outcome = await discovery.discover(DEFINITION, workspaceScope('ws_1', 'bnd_1'));

    expect(outcome.capabilities).toHaveLength(1);
    expect(outcome.capabilities[0]).toMatchObject({
      kind: 'tool',
      name: 'create_event',
      canonicalName: 'calendar__create_event',
      title: 'Create event',
      annotations: { readOnlyHint: false },
    });
  });

  it('records the scope the surface was discovered for', async () => {
    const discovery = new CapabilityDiscovery(new FakeManager({ tools: [TOOL] }));
    const asUser = await discovery.discover(DEFINITION, userScope('ws_1', 'bnd_1', 'usr_1'));
    expect(asUser.scopeKey).toBe('user:usr_1');
  });

  it('discovers only tools unless asked for more', async () => {
    // Prompts and resources cost a round trip each and nothing in Phase 1 reads
    // them.
    const manager = new FakeManager({ tools: [TOOL], prompts: [{ name: 'brief' }] });
    const discovery = new CapabilityDiscovery(manager);

    const narrow = await discovery.discover(DEFINITION, workspaceScope('ws_1', 'bnd_1'));
    expect(narrow.capabilities.map((c) => c.kind)).toEqual(['tool']);

    const wide = await discovery.discover(
      DEFINITION, workspaceScope('ws_2', 'bnd_1'), { kinds: ['tool', 'prompt'] },
    );
    expect(wide.capabilities.map((c) => c.kind)).toEqual(['tool', 'prompt']);
  });

  it('keys a resource by its URI, not its display name', async () => {
    // Two resources may legitimately share a title; the URI is the identity.
    const manager = new FakeManager({
      resources: [{ uri: 'file:///notes.md', name: 'Notes', title: 'Notes' }],
    });
    const outcome = await new CapabilityDiscovery(manager).discover(
      DEFINITION, workspaceScope('ws_1', 'bnd_1'), { kinds: ['resource'] },
    );

    expect(outcome.capabilities[0]).toMatchObject({
      name: 'file:///notes.md',
      canonicalName: 'calendar__file:///notes.md',
    });
  });

  it('reports a refused verb instead of failing the whole pass', async () => {
    // A server with no tools capability is normal, not an outage — and hiding
    // the reason leaves an operator guessing why a binding came back thin.
    const manager = new FakeManager({ toolsThrow: new Error('Method not found') });
    const outcome = await new CapabilityDiscovery(manager).discover(
      DEFINITION, workspaceScope('ws_1', 'bnd_1'),
    );

    expect(outcome.capabilities).toEqual([]);
    expect(outcome.skipped).toEqual([{ verb: 'tools/list', reason: 'Method not found' }]);
  });

  it('reports the protocol era, so a legacy server is visible to an operator', async () => {
    const modern = await new CapabilityDiscovery(new FakeManager({ tools: [] })).discover(
      DEFINITION, workspaceScope('ws_1', 'bnd_1'),
    );
    expect(modern.protocolEra).toBe('modern');

    const legacy = await new CapabilityDiscovery(new FakeManager({ tools: [], era: 'legacy' }))
      .discover(DEFINITION, workspaceScope('ws_1', 'bnd_1'));
    expect(legacy.protocolEra).toBe('legacy');
  });
});

describe('freshness', () => {
  it('serves a second call from cache', async () => {
    const manager = new FakeManager({ tools: [TOOL], ttlMs: 60_000 });
    const discovery = new CapabilityDiscovery(manager);
    const scope = workspaceScope('ws_1', 'bnd_1');

    const first = await discovery.discover(DEFINITION, scope);
    const second = await discovery.discover(DEFINITION, scope);

    expect(first.servedFromCache).toBe(false);
    expect(second.servedFromCache).toBe(true);
    expect(manager.calls).toBe(1);
  });

  it('refetches when asked to refresh, as after a re-auth', async () => {
    const manager = new FakeManager({ tools: [TOOL] });
    const discovery = new CapabilityDiscovery(manager);
    const scope = workspaceScope('ws_1', 'bnd_1');

    await discovery.discover(DEFINITION, scope);
    const fresh = await discovery.discover(DEFINITION, scope, { refresh: true });

    expect(fresh.servedFromCache).toBe(false);
    expect(manager.calls).toBe(2);
  });

  it('does not cache at all when the server authorised no TTL', async () => {
    const manager = new FakeManager({ tools: [TOOL], ttlMs: 0 });
    const discovery = new CapabilityDiscovery(manager);
    const scope = workspaceScope('ws_1', 'bnd_1');

    await discovery.discover(DEFINITION, scope);
    await discovery.discover(DEFINITION, scope);
    expect(manager.calls).toBe(2);
  });

  it('takes the shortest TTL across the verbs it called', async () => {
    // A generous verb must not extend the life of a stricter one.
    const manager = new FakeManager({ tools: [TOOL], ttlMs: 60_000, discoverTtlMs: 5_000 });
    const outcome = await new CapabilityDiscovery(manager).discover(
      DEFINITION, workspaceScope('ws_1', 'bnd_1'),
    );
    expect(outcome.ttlMs).toBe(5_000);
  });

  it('clamps a hostile TTL so stale capabilities cannot be pinned in place', async () => {
    const manager = new FakeManager({ tools: [TOOL], ttlMs: 365 * 24 * 60 * 60 * 1000 });
    const outcome = await new CapabilityDiscovery(manager).discover(
      DEFINITION, workspaceScope('ws_1', 'bnd_1'),
    );
    expect(outcome.ttlMs).toBe(10 * 60 * 1000);
  });

  it('drops a binding’s cache on invalidation', async () => {
    const manager = new FakeManager({ tools: [TOOL] });
    const discovery = new CapabilityDiscovery(manager);
    const scope = workspaceScope('ws_1', 'bnd_1');

    await discovery.discover(DEFINITION, scope);
    expect(discovery.invalidate('ws_1', 'bnd_1')).toBe(1);
    await discovery.discover(DEFINITION, scope);
    expect(manager.calls).toBe(2);
  });
});

describe('🔒 per-user isolation', () => {
  // The binding authenticates each user separately, so each sees a different
  // surface. One user's cached discovery reaching another is a cross-tenant
  // leak of both tool names and, through them, of what that person can do.
  const perUser = (scope: ConnectionScopeKey): FakeServer =>
    scope.kind === 'user' && scope.userId === 'usr_alice'
      ? { tools: [{ name: 'alice_calendar' }], cacheScope: 'private' }
      : { tools: [{ name: 'bob_calendar' }], cacheScope: 'private' };

  it('never serves one user’s discovery to another on a per-user binding', async () => {
    const manager = new FakeManager(perUser);
    const discovery = new CapabilityDiscovery(manager);

    const alice = await discovery.discover(DEFINITION, userScope('ws_1', 'bnd_1', 'usr_alice'));
    const bob = await discovery.discover(DEFINITION, userScope('ws_1', 'bnd_1', 'usr_bob'));

    expect(alice.capabilities[0]?.name).toBe('alice_calendar');
    expect(bob.capabilities[0]?.name).toBe('bob_calendar');
    // Bob's call went to the server; it was not answered from Alice's entry.
    expect(bob.servedFromCache).toBe(false);
    expect(manager.calls).toBe(2);
  });

  it('treats an unstated cacheScope as unshareable', async () => {
    // Absent is not permission. The cost of being wrong this way is a refetch;
    // the cost of the other way is a leak.
    const manager = new FakeManager((scope) =>
      scope.kind === 'user' && scope.userId === 'usr_alice'
        ? { tools: [{ name: 'alice_only' }], cacheScope: undefined }
        : { tools: [{ name: 'bob_only' }], cacheScope: undefined });
    const discovery = new CapabilityDiscovery(manager);

    await discovery.discover(DEFINITION, userScope('ws_1', 'bnd_1', 'usr_alice'));
    const bob = await discovery.discover(DEFINITION, userScope('ws_1', 'bnd_1', 'usr_bob'));

    expect(bob.capabilities[0]?.name).toBe('bob_only');
  });

  it('keeps two workspaces apart even on a workspace-scoped binding', async () => {
    const manager = new FakeManager((scope) =>
      scope.workspaceId === 'ws_1' ? { tools: [{ name: 'one' }] } : { tools: [{ name: 'two' }] });
    const discovery = new CapabilityDiscovery(manager);

    const one = await discovery.discover(DEFINITION, workspaceScope('ws_1', 'bnd_1'));
    const two = await discovery.discover(DEFINITION, workspaceScope('ws_2', 'bnd_1'));

    expect(one.capabilities[0]?.name).toBe('one');
    expect(two.capabilities[0]?.name).toBe('two');
  });

  it('shares only what the server explicitly marked public', async () => {
    // `public` is the spec's own statement that a response carries nothing
    // principal-specific. Honouring it is what keeps a shared catalogue cheap.
    const manager = new FakeManager({ tools: [{ name: 'public_tool' }], cacheScope: 'public' });
    const discovery = new CapabilityDiscovery(manager);

    await discovery.discover(DEFINITION, userScope('ws_1', 'bnd_1', 'usr_alice'));
    const bob = await discovery.discover(DEFINITION, userScope('ws_1', 'bnd_1', 'usr_bob'));

    expect(bob.servedFromCache).toBe(true);
    expect(manager.calls).toBe(1);
  });

  it('shares a cache instance across bindings without letting entries collide', async () => {
    const cache = new ScopedResponseCache();
    const other: McpServerDefinition = { ...DEFINITION, bindingId: 'bnd_2', alias: 'crm' };
    const manager = new FakeManager({ tools: [TOOL] });
    const discovery = new CapabilityDiscovery(manager, cache);

    await discovery.discover(DEFINITION, workspaceScope('ws_1', 'bnd_1'));
    const second = await discovery.discover(other, workspaceScope('ws_1', 'bnd_2'));

    expect(second.servedFromCache).toBe(false);
    expect(second.capabilities[0]?.canonicalName).toBe('crm__create_event');
  });
});
