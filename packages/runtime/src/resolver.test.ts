import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BUDGET, asProviderType, emptyConsumption, emptyUsage,
  type AgentProvider, type ModelCapabilities, type Principal, type ProviderRegistry,
  type Run, type RunContext,
} from '@salvations/core';
import {
  ModelUnavailableError, PrincipalRevokedError, Resolver,
  type ModelBinding, type ResolverDeps,
} from './resolver';

const capabilities = (over: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  ({ modelId: 'model-x', maxInputTokens: 100_000, maxOutputTokens: 4_096, ...over }) as ModelCapabilities;

const provider = (type = 'anthropic'): AgentProvider => ({
  providerType: asProviderType(type),
  describeModel: async () => capabilities(),
  generate: () => (async function* () {})(),
});

const PRINCIPAL: Principal = {
  type: 'user', userId: 'usr_1' as never, workspaceId: 'ws_1' as never, role: 'member',
};

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1' as Run['id'],
  workspaceId: 'ws_1' as Run['workspaceId'],
  conversationId: 'cnv_1' as Run['conversationId'],
  agentId: 'agt_1' as Run['agentId'],
  agentVersionId: 'av_1' as Run['agentVersionId'],
  agentSnapshot: {
    systemPrompt: 'the pinned prompt',
    modelRole: 'chat',
    capabilityBindings: [],
    guardrails: { maxToolCallsPerTurn: 8 },
  },
  modelBindingId: 'mb_1' as Run['modelBindingId'],
  trigger: { type: 'user' },
  principal: PRINCIPAL,
  status: 'running',
  priority: 0,
  scheduledFor: new Date(0),
  attempts: 1,
  budget: DEFAULT_BUDGET,
  consumed: emptyConsumption,
  usage: emptyUsage,
  nextStepSeq: 3,
  depth: 0,
  queuedAt: new Date(0),
  ...over,
});

const binding = (over: Partial<ModelBinding> = {}): ModelBinding => ({
  id: 'mb_1', providerType: asProviderType('anthropic'), modelId: 'model-x', ...over,
});

const registry = (types = ['anthropic']): ProviderRegistry => ({
  has: (t) => types.includes(String(t)),
  create: (t) => provider(String(t)),
  knownTypes: () => types.map(asProviderType),
});

function deps(over: Partial<ResolverDeps> = {}): ResolverDeps {
  const bindings = new Map([['mb_1', binding()]]);
  return {
    providers: registry(),
    loadModelBinding: async (id) => bindings.get(id),
    credentialsFor: async () => ({ apiKey: 'k' }),
    describeModel: async () => capabilities(),
    revalidatePrincipal: async (p) => p,
    bindingIdByAlias: async () => new Map([['calendar', 'bnd_1']]),
    systemDirectives: async (r) => [{ kind: 'identity', text: r.agentSnapshot.systemPrompt }],
    ...over,
  };
}

describe('the run context', () => {
  it('uses the snapshot pinned on the run, not the agent as it is now', async () => {
    // A run that changed behaviour halfway because someone edited its prompt is
    // neither reproducible nor debuggable.
    const resolved = await new Resolver(deps()).resolve(run());
    expect(resolved.ctx.agentSnapshot.systemPrompt).toBe('the pinned prompt');
    expect(resolved.systemDirectives).toEqual([{ kind: 'identity', text: 'the pinned prompt' }]);
  });

  it('carries the run’s own budget and what it has already spent', async () => {
    const resolved = await new Resolver(deps()).resolve(
      run({ consumed: { ...emptyConsumption, steps: 4 }, nextStepSeq: 9 }),
    );
    expect(resolved.ctx.consumed.steps).toBe(4);
    expect(resolved.ctx.stepSeq).toBe(9);
  });

  it('keys artifacts by provider and model together', async () => {
    const resolved = await new Resolver(deps()).resolve(run());
    expect(resolved.ctx.providerKey).toBe('anthropic:model-x');
  });
});

describe('authority is re-checked on every resume', () => {
  it('refuses a run whose principal lost its authority', async () => {
    // A run suspended for two days must not resume with access revoked
    // yesterday. The snapshot says who it was, not that they are still allowed.
    await expect(
      new Resolver(deps({ revalidatePrincipal: async () => undefined })).resolve(run()),
    ).rejects.toThrow(PrincipalRevokedError);
  });

  it('uses the re-validated principal, not the snapshot', async () => {
    // A demotion must take effect, not merely fail to stop the run.
    const demoted: Principal = { ...PRINCIPAL, role: 'viewer' };
    const resolved = await new Resolver(deps({ revalidatePrincipal: async () => demoted }))
      .resolve(run());
    expect(resolved.ctx.principal).toEqual(demoted);
  });

  it('checks authority before decrypting any credential', async () => {
    const credentialsFor = vi.fn(async () => ({ apiKey: 'k' }));
    await expect(
      new Resolver(deps({ revalidatePrincipal: async () => undefined, credentialsFor }))
        .resolve(run()),
    ).rejects.toThrow(PrincipalRevokedError);
    expect(credentialsFor).not.toHaveBeenCalled();
  });
});

describe('model resolution', () => {
  it('says plainly when a binding does not exist', async () => {
    await expect(
      new Resolver(deps({ loadModelBinding: async () => undefined })).resolve(run()),
    ).rejects.toThrow(ModelUnavailableError);
  });

  it('says plainly when no adapter is registered for the provider type', async () => {
    // Better than a null dereference three layers down.
    await expect(
      new Resolver(deps({ providers: registry(['openai']) })).resolve(run()),
    ).rejects.toThrow(/No adapter is registered/);
  });

  it('offers a fallback attempt when the binding names one', async () => {
    const bindings = new Map([
      ['mb_1', binding({ fallbackBindingId: 'mb_2' })],
      ['mb_2', binding({ id: 'mb_2', modelId: 'model-y' })],
    ]);
    const resolved = await new Resolver(deps({
      loadModelBinding: async (id) => bindings.get(id),
    })).resolve(run());

    const attempts = resolved.attemptsFor({} as never);
    expect(attempts.map((a) => a.label)).toEqual(['primary', 'fallback']);
    expect(attempts[1]?.modelId).toBe('model-y');
  });

  it('runs without a fallback rather than failing when the fallback is missing', async () => {
    // A misconfigured fallback must not take down a working primary.
    const bindings = new Map([['mb_1', binding({ fallbackBindingId: 'gone' })]]);
    const resolved = await new Resolver(deps({
      loadModelBinding: async (id) => bindings.get(id),
    })).resolve(run());

    expect(resolved.attemptsFor({} as never).map((a) => a.label)).toEqual(['primary']);
  });

  it('never asks for more output than the model can produce', async () => {
    const bindings = new Map([['mb_1', binding({ maxOutputTokens: 100_000 })]]);
    const resolved = await new Resolver(deps({
      loadModelBinding: async (id) => bindings.get(id),
    })).resolve(run());
    expect(resolved.maxOutputTokens).toBe(4_096);
  });

  it('honours a lower per-binding output cap', async () => {
    const bindings = new Map([['mb_1', binding({ maxOutputTokens: 512 })]]);
    const resolved = await new Resolver(deps({
      loadModelBinding: async (id) => bindings.get(id),
    })).resolve(run());
    expect(resolved.maxOutputTokens).toBe(512);
  });

  it('carries the rate card through, so cost is priced per binding', async () => {
    const bindings = new Map([
      ['mb_1', binding({ rates: { inputPerMTok: 3, outputPerMTok: 15 } })],
    ]);
    const resolved = await new Resolver(deps({
      loadModelBinding: async (id) => bindings.get(id),
    })).resolve(run());
    expect(resolved.rates).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it('takes capabilities from the adapter as data', async () => {
    // Nothing here or downstream asks which vendor it is talking to.
    const resolved = await new Resolver(deps({
      describeModel: async () => capabilities({ maxInputTokens: 42 }),
    })).resolve(run());
    expect((resolved.ctx as RunContext).capabilities.maxInputTokens).toBe(42);
  });
});
