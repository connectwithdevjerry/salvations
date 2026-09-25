import { describe, expect, it } from 'vitest';
import {
  BindingUnavailableError, McpServerRegistry, effectiveMrtrPolicy,
  type BindingRecord, type BindingSource, type ServerRecord,
} from './registry';
import {
  DEFAULT_RESERVE_MS, DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS, assertTimeoutBudget,
} from '@salvations/core';

/** Overrides may clear a field — that is how "no URL configured" is expressed. */
type Over<T> = { [K in keyof T]?: T[K] | undefined };

const BASE_BINDING: BindingRecord = {
  id: 'bnd_1',
  workspaceId: 'ws_1',
  mcpServerId: 'srv_1',
  alias: 'calendar',
  enabled: true,
  status: 'connected',
  perUserAuth: false,
};

const BASE_SERVER: ServerRecord = {
  id: 'srv_1',
  slug: 'calendar',
  transport: 'streamable_http',
  url: 'https://example.test/mcp',
  authMode: 'oauth2',
  trustTier: 'verified',
};

// The cast is what lets an override CLEAR an optional field; spreading a
// partial into a literal would otherwise make every required field optional.
const binding = (over: Over<BindingRecord> = {}): BindingRecord =>
  ({ ...BASE_BINDING, ...over }) as BindingRecord;

const server = (over: Over<ServerRecord> = {}): ServerRecord =>
  ({ ...BASE_SERVER, ...over }) as ServerRecord;

function source(
  records: { binding: BindingRecord; server: ServerRecord }[],
): BindingSource {
  return {
    load: async (workspaceId, bindingId) =>
      records.find((r) => r.binding.workspaceId === workspaceId && r.binding.id === bindingId),
    listEnabled: async (workspaceId) =>
      records.filter((r) => r.binding.workspaceId === workspaceId),
  };
}

const registry = (records: { binding: BindingRecord; server: ServerRecord }[]) =>
  new McpServerRegistry(source(records));

describe('resolution', () => {
  it('builds a transport definition from the binding and its server', async () => {
    const resolved = await registry([{ binding: binding(), server: server() }])
      .resolve('ws_1', 'bnd_1');

    expect(resolved.definition).toEqual({
      bindingId: 'bnd_1',
      serverId: 'srv_1',
      // The workspace's own alias, not the publisher's slug: it is what makes
      // canonical tool names collision-free.
      alias: 'calendar',
      transport: 'streamable_http',
      url: 'https://example.test/mcp',
    });
  });

  it('carries a version pin through for a server that misbehaves under probing', async () => {
    const resolved = await registry([
      { binding: binding(), server: server({ protocolVersionPin: '2025-06-18' }) },
    ]).resolve('ws_1', 'bnd_1');

    expect(resolved.definition.protocolVersionPin).toBe('2025-06-18');
  });

  it('refuses a binding from another workspace', async () => {
    await expect(registry([{ binding: binding(), server: server() }]).resolve('ws_2', 'bnd_1'))
      .rejects.toThrow(BindingUnavailableError);
  });
});

describe('a binding that cannot be used says why', () => {
  const cases: [Over<BindingRecord>, Over<ServerRecord>, string, RegExp][] = [
    [{ enabled: false }, {}, 'disabled', /disabled for this workspace/],
    [{ status: 'disabled' }, {}, 'disabled', /disabled for this workspace/],
    [{ status: 'pending_auth' }, {}, 'pending_auth', /not been authorised yet/],
    [{ status: 'error' }, {}, 'errored', /error state/],
    [{}, { transport: 'stdio' }, 'unsupported_transport', /not enabled in this deployment/],
    [{}, { url: undefined }, 'no_url', /no URL configured/],
  ];

  for (const [b, s, reason, message] of cases) {
    it(`reports ${reason}`, async () => {
      // A silent skip here becomes "the agent just didn't use the tool", which
      // is the hardest possible thing for an operator to diagnose.
      const r = registry([{ binding: binding(b), server: server(s) }]);
      await expect(r.resolve('ws_1', 'bnd_1')).rejects.toMatchObject({ reason });
      await expect(r.resolve('ws_1', 'bnd_1')).rejects.toThrow(message);
    });
  }
});

describe('per-user bindings', () => {
  it('scopes the connection to the calling user', async () => {
    const resolved = await registry([
      { binding: binding({ perUserAuth: true }), server: server() },
    ]).resolve('ws_1', 'bnd_1', 'usr_1');

    expect(resolved.scope).toEqual({
      kind: 'user', workspaceId: 'ws_1', bindingId: 'bnd_1', userId: 'usr_1',
    });
  });

  it('refuses to resolve one without a user rather than falling back', async () => {
    // A workspace-scoped fallback would let one person act with another's tokens.
    await expect(
      registry([{ binding: binding({ perUserAuth: true }), server: server() }])
        .resolve('ws_1', 'bnd_1'),
    ).rejects.toThrow(/requires per-user authentication/);
  });

  it('keeps a workspace-scoped binding workspace-scoped even when a user is known', async () => {
    const resolved = await registry([{ binding: binding(), server: server() }])
      .resolve('ws_1', 'bnd_1', 'usr_1');
    expect(resolved.scope.kind).toBe('workspace');
  });
});

describe('MRTR policy is floored by trust', () => {
  it('denies inference by default whatever the tier', () => {
    expect(effectiveMrtrPolicy(binding(), server({ trustTier: 'first_party' })).allowInference)
      .toBe(false);
  });

  it('honours an opt-in for a trusted publisher', () => {
    const policy = effectiveMrtrPolicy(
      binding({ mrtr: { allowInference: true } }), server({ trustTier: 'verified' }),
    );
    expect(policy.allowInference).toBe(true);
  });

  it('refuses to grant inference to an unvetted publisher, however configured', () => {
    // Trust tier is a ceiling, not a default. Spending the workspace's model
    // budget on prompts an anonymous publisher writes is not undoable after
    // the fact, so it is not one admin toggle away.
    for (const trustTier of ['community', 'untrusted'] as const) {
      const policy = effectiveMrtrPolicy(
        binding({ mrtr: { allowInference: true } }), server({ trustTier }),
      );
      expect(policy.allowInference).toBe(false);
    }
  });

  it('lets a binding turn human interruption off but caps its round count', () => {
    const policy = effectiveMrtrPolicy(
      binding({ mrtr: { allowHumanInput: false, maxRounds: 10_000 } }), server(),
    );
    expect(policy.allowHumanInput).toBe(false);
    expect(policy.maxRounds).toBe(16);
  });
});

describe('timeouts', () => {
  it('uses the default when a binding sets none', async () => {
    const resolved = await registry([{ binding: binding(), server: server() }])
      .resolve('ws_1', 'bnd_1');
    expect(resolved.timeoutMs).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  it('caps a per-binding timeout so one server cannot hold a run slice', async () => {
    // Clamped rather than refused: a slow server is a reason to wait longer
    // than default, never a reason to risk the slice.
    const resolved = await registry([
      { binding: binding({ timeoutMs: 60 * 60 * 1000 }), server: server() },
    ]).resolve('ws_1', 'bnd_1');
    expect(resolved.timeoutMs).toBe(MAX_TOOL_TIMEOUT_MS);
  });

  it('keeps the tool ceiling strictly below the slice reserve', () => {
    // Otherwise the environment kills the invocation before our own timeout
    // fires, and an error message the model could read becomes a lease reclaim
    // and possibly a repeated side effect.
    expect(MAX_TOOL_TIMEOUT_MS).toBeLessThan(DEFAULT_RESERVE_MS);
    expect(() => assertTimeoutBudget(300_000)).not.toThrow();
    expect(() => assertTimeoutBudget(300_000, MAX_TOOL_TIMEOUT_MS)).toThrow(/before the/);
  });
});

describe('listing', () => {
  it('skips an unusable binding instead of losing the whole surface', async () => {
    // One server awaiting consent must not take every other tool down with it.
    const resolved = await registry([
      { binding: binding(), server: server() },
      { binding: binding({ id: 'bnd_2', alias: 'crm', status: 'pending_auth' }), server: server() },
      { binding: binding({ id: 'bnd_3', alias: 'docs' }), server: server({ id: 'srv_3' }) },
    ]).listUsable('ws_1');

    expect(resolved.map((r) => r.definition.alias)).toEqual(['calendar', 'docs']);
  });

  it('surfaces a caller’s own mistake rather than silently dropping the binding', async () => {
    // A per-user binding listed with no user is a bug in the caller, and a
    // quietly shorter tool list is the worst way to learn about it.
    await expect(
      registry([{ binding: binding({ perUserAuth: true }), server: server() }]).listUsable('ws_1'),
    ).rejects.toThrow(/requires per-user authentication/);
  });
});

describe('connection auth', () => {
  it('asks for headers per scope and never caches them', async () => {
    // A resolved definition can carry a bearer token; a cached one is a token
    // with an unbounded lifetime attached to a key someone else may reach.
    const seen: string[] = [];
    const r = new McpServerRegistry(source([{ binding: binding({ perUserAuth: true }), server: server() }]), {
      headersFor: async (_b, _s, scope) => {
        seen.push(scope.kind === 'user' ? scope.userId : 'workspace');
        return { authorization: `Bearer token-for-${seen.length}` };
      },
    });

    const first = await r.resolve('ws_1', 'bnd_1', 'usr_a');
    const second = await r.resolve('ws_1', 'bnd_1', 'usr_b');

    expect(seen).toEqual(['usr_a', 'usr_b']);
    expect(first.definition.headers).toEqual({ authorization: 'Bearer token-for-1' });
    expect(second.definition.headers).toEqual({ authorization: 'Bearer token-for-2' });
  });

  it('resolves without headers when a server needs none', async () => {
    const resolved = await registry([
      { binding: binding(), server: server({ authMode: 'none' }) },
    ]).resolve('ws_1', 'bnd_1');
    expect(resolved.definition.headers).toBeUndefined();
  });
});
