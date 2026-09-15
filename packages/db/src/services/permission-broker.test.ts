import { describe, expect, it } from 'vitest';
import { scopesFor, type BrokerInput } from './permission-broker';
import { asId, type AgentId, type ApiKeyId, type Principal, type RunId, type UserId, type WorkspaceId } from '@salvations/core';

const WS = asId<WorkspaceId>('wks_1');
const USER = asId<UserId>('usr_1');

const input = (over: Partial<BrokerInput>): BrokerInput => ({
  principal: { type: 'user', userId: USER, workspaceId: WS, role: 'member' },
  bindingId: 'mcb_1',
  scopeKey: 'workspace',
  capabilityName: 'create_issue',
  args: {},
  callsThisRun: 0,
  ...over,
});

describe('policy scope resolution', () => {
  it('always includes the workspace scope', () => {
    expect(scopesFor(input({}))).toContainEqual({ type: 'workspace' });
  });

  it('adds the agent scope when a run is agent-bound', () => {
    expect(scopesFor(input({ agentId: 'agt_1' }))).toContainEqual({ type: 'agent', id: 'agt_1' });
  });

  it('adds a member scope for a user principal', () => {
    expect(scopesFor(input({}))).toContainEqual({ type: 'member', id: USER });
  });

  it('adds an apiKey scope for a key principal', () => {
    const principal: Principal = {
      type: 'api_key', apiKeyId: asId<ApiKeyId>('key_1'), workspaceId: WS, scopes: [],
    };
    expect(scopesFor(input({ principal }))).toContainEqual({ type: 'apiKey', id: 'key_1' });
  });

  it('resolves an agent principal to the human it acts for', () => {
    // Policy written for a person must apply to that person's agent. Scoping to
    // the agent's own id instead would silently bypass their restrictions.
    const principal: Principal = {
      type: 'agent',
      agentId: asId<AgentId>('agt_1'),
      runId: asId<RunId>('run_1'),
      workspaceId: WS,
      onBehalfOf: { type: 'user', userId: USER, workspaceId: WS, role: 'member' },
    };
    const scopes = scopesFor(input({ principal, agentId: 'agt_1' }));
    expect(scopes).toContainEqual({ type: 'member', id: USER });
    expect(scopes).toContainEqual({ type: 'agent', id: 'agt_1' });
  });

  it('adds a channel scope for an unlinked channel identity', () => {
    const principal: Principal = {
      type: 'channel_identity', identityId: 'cid_1', workspaceId: WS, trust: 'unlinked',
    };
    expect(scopesFor(input({ principal }))).toContainEqual({ type: 'channel', id: 'cid_1' });
  });

  it('adds no principal scope for a system principal', () => {
    const principal: Principal = { type: 'system', reason: 'sweeper', workspaceId: WS };
    expect(scopesFor(input({ principal }))).toEqual([{ type: 'workspace' }]);
  });

  it('never loads more than three scopes — a decision stays cheap', () => {
    const principal: Principal = {
      type: 'agent',
      agentId: asId<AgentId>('agt_1'),
      runId: asId<RunId>('run_1'),
      workspaceId: WS,
      onBehalfOf: { type: 'user', userId: USER, workspaceId: WS, role: 'owner' },
    };
    expect(scopesFor(input({ principal, agentId: 'agt_1' }))).toHaveLength(3);
  });
});
