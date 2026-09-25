import { describe, expect, it } from 'vitest';
import { effectiveGrants, hasPermission, rootUserId, type Principal } from './principal';
import { asId } from '../ids';
import type { AgentId, ApiKeyId, RunId, UserId, WorkspaceId } from '../ids';

const WS = asId<WorkspaceId>('wks_1');
const USER = asId<UserId>('usr_1');

const owner: Principal = { type: 'user', userId: USER, workspaceId: WS, role: 'owner' };
const viewer: Principal = { type: 'user', userId: USER, workspaceId: WS, role: 'viewer' };

const agentFor = (onBehalfOf: Principal): Principal => ({
  type: 'agent',
  agentId: asId<AgentId>('agt_1'),
  runId: asId<RunId>('run_1'),
  workspaceId: WS,
  onBehalfOf,
});

describe('delegation — an agent never exceeds its caller', () => {
  it('never grants administrative permissions, even acting for an owner', () => {
    const grants = effectiveGrants(agentFor(owner));
    expect(grants).not.toContain('credentials:read');
    expect(grants).not.toContain('members:manage');
    expect(grants).not.toContain('mcp:approve');
    expect(grants).not.toContain('workspace:delete');
  });

  it('keeps the conversational permissions an owner does have', () => {
    expect(hasPermission(agentFor(owner), 'conversations:write')).toBe(true);
    expect(hasPermission(agentFor(owner), 'runs:create')).toBe(true);
  });

  it('cannot exceed a viewer caller — a viewer’s agent cannot write', () => {
    expect(hasPermission(agentFor(viewer), 'conversations:write')).toBe(false);
    expect(hasPermission(agentFor(viewer), 'conversations:read')).toBe(true);
  });

  it('does not regain permissions through nested delegation', () => {
    // A sub-agent of a sub-agent of a viewer is still bounded by the viewer.
    const nested = agentFor(agentFor(agentFor(viewer)));
    expect(hasPermission(nested, 'conversations:write')).toBe(false);
    expect(hasPermission(nested, 'agents:write')).toBe(false);
  });

  it('bounds an api-key-backed agent by the key’s scopes', () => {
    const key: Principal = {
      type: 'api_key',
      apiKeyId: asId<ApiKeyId>('key_1'),
      workspaceId: WS,
      scopes: ['runs:create', 'conversations:read'],
    };
    const grants = effectiveGrants(agentFor(key));
    expect(grants).toContain('runs:create');
    expect(grants).toContain('conversations:read');
    expect(grants).not.toContain('conversations:write');
  });
});

describe('channel identities', () => {
  it('treats an unlinked channel user as a stranger, not a member', () => {
    const unlinked: Principal = {
      type: 'channel_identity', identityId: 'cid_1', workspaceId: WS, trust: 'unlinked',
    };
    expect(hasPermission(unlinked, 'conversations:read')).toBe(false);
    expect(hasPermission(unlinked, 'agents:read')).toBe(false);
  });
});

describe('accountability', () => {
  it('traces an agent back to the responsible human', () => {
    expect(rootUserId(agentFor(agentFor(owner)))).toBe(USER);
  });

  it('reports no responsible human for a system principal', () => {
    expect(rootUserId({ type: 'system', reason: 'sweeper', workspaceId: WS })).toBeUndefined();
  });
});
