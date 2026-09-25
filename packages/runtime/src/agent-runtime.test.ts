import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET, asProviderType, emptyConsumption, emptyUsage, providerKey,
  type AgentProvider, type ContentBlock, type McpBindingId, type Message, type MessageId,
  type ModelCapabilities, type ProviderEvent, type RunConsumption, type RunContext,
  type ToolDeclaration, type ToolGateway, type ToolOutcome, type Usage,
} from '@salvations/core';
import { AgentRuntime, pendingToolCalls, type ResolvedRun } from './agent-runtime';
import { LoopDetector } from './loop-detection';
import type { AppendMessage, RecordedStep, RunStateStore, ToolInvocationResult } from './state';

const MODEL = providerKey('test', 'model-x');

const capabilities = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  modelId: 'model-x',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_096,
  tools: {
    supported: true, parallelCalls: true, forcedChoice: true,
    namePattern: '^[a-zA-Z0-9_-]{1,64}$', maxNameLength: 64,
    jsonSchemaDialect: '2020-12', strictMode: false,
  },
  reasoning: { supported: false, mode: 'none', artifactsMustReplay: false, artifactsPortable: false },
  promptCache: { supported: false, strategy: 'none' },
  structuredOutput: { supported: false, mechanism: 'none' },
  modalities: { imageInput: false, documentInput: false, audioInput: false },
  assistantPrefill: false,
  systemMessagePlacement: 'top_level',
  streaming: true,
  ...over,
});

/** An in-memory store, so a step can be exercised end to end without a database. */
class FakeStore implements RunStateStore {
  messages: Message[] = [];
  steps: RecordedStep[] = [];
  toolResults = new Map<string, ToolInvocationResult>();
  consumption: RunConsumption = emptyConsumption;
  usage: Usage = emptyUsage;
  #seq = 0;

  constructor(seed: Message[] = []) { this.messages = [...seed]; this.#seq = seed.length; }

  async loadMessages() { return this.messages; }

  async appendMessage(message: AppendMessage): Promise<Message> {
    const appended = {
      id: `msg_${this.#seq}` as MessageId,
      conversationId: 'cnv_1' as Message['conversationId'],
      seq: this.#seq++,
      createdAt: new Date(0),
      ...message,
    } as Message;
    this.messages.push(appended);
    return appended;
  }

  async supersede(ids: readonly MessageId[], by: MessageId) {
    this.messages = this.messages.map((m) =>
      ids.includes(m.id) ? { ...m, supersededBy: by } : m);
  }

  async recordStep(step: RecordedStep) { this.steps.push(step); }

  async saveConsumption(consumed: RunConsumption, usage: Usage) {
    this.consumption = consumed;
    this.usage = usage;
  }

  async completedToolCalls() { return this.toolResults; }

  async saveToolResult(result: ToolInvocationResult) {
    this.toolResults.set(result.id, result);
  }
}

let seq = 0;
const message = (role: Message['role'], content: readonly ContentBlock[]): Message => ({
  id: `seed_${seq}` as MessageId,
  conversationId: 'cnv_1' as Message['conversationId'],
  seq: seq++,
  role,
  content,
  createdAt: new Date(0),
});

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

const toolUse = (id: string, name: string, input: unknown = {}): ContentBlock =>
  ({ type: 'tool_use', id, name, input });

function provider(...streams: ProviderEvent[][]): AgentProvider {
  const queue = [...streams];
  return {
    providerType: asProviderType('test'),
    describeModel: async () => capabilities(),
    generate(): AsyncIterable<ProviderEvent> {
      const events = queue.shift() ?? [];
      return (async function* () { for (const e of events) yield e; })();
    },
  };
}

const finish = (content: ContentBlock[], usage: Usage = emptyUsage): ProviderEvent =>
  ({ type: 'finish', reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
     content, usage });

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  runId: 'run_1' as RunContext['runId'],
  workspaceId: 'ws_1' as RunContext['workspaceId'],
  conversationId: 'cnv_1' as RunContext['conversationId'],
  agentId: 'agt_1' as RunContext['agentId'],
  agentSnapshot: {
    systemPrompt: 'be useful',
    modelRole: 'chat',
    capabilityBindings: [{ bindingId: 'bnd_1' as McpBindingId, mode: 'all', tools: [] }],
    guardrails: { maxToolCallsPerTurn: 8 },
  },
  modelBindingId: 'mb_1' as RunContext['modelBindingId'],
  providerKey: MODEL,
  capabilities: capabilities(),
  principal: {} as RunContext['principal'],
  budget: DEFAULT_BUDGET,
  consumed: emptyConsumption,
  stepSeq: 0,
  ...over,
});

const resolved = (p: AgentProvider, over: Partial<ResolvedRun> = {}): ResolvedRun => ({
  ctx: ctx(),
  attemptsFor: () => [{ provider: p, modelId: 'model-x', label: 'primary' }],
  bindingIdByAlias: new Map([['calendar', 'bnd_1']]),
  systemDirectives: [{ kind: 'identity', text: 'be useful' }],
  maxOutputTokens: 4_096,
  ...over,
});

const declaration = (name: string): ToolDeclaration =>
  ({ name, description: '', inputSchema: { type: 'object' } });

function gateway(
  invoke: (name: string, input: unknown) => ToolOutcome | Promise<ToolOutcome>,
  tools: readonly string[] = ['calendar__create'],
): ToolGateway & { invocations: string[] } {
  const invocations: string[] = [];
  return {
    invocations,
    listAvailable: async () => tools.map(declaration),
    invoke: async (name, input) => { invocations.push(name); return invoke(name, input); },
  };
}

const okResult = (t: string): ToolOutcome => ({
  kind: 'result', content: text(t), isError: false,
  bindingId: 'bnd_1' as McpBindingId, durationMs: 1, mrtrRounds: 0,
});

const signal = new AbortController().signal;

const runtimeWith = (store: RunStateStore, g: ToolGateway, over = {}) =>
  new AgentRuntime({ store, gateway: g, now: () => 1_000, ...over });

describe('one step does one thing', () => {
  it('makes a model call and finishes when the model answers', async () => {
    seq = 0;
    const store = new FakeStore([message('user', text('hello'))]);
    const p = provider([finish(text('hi there'))]);

    const outcome = await runtimeWith(store, gateway(() => okResult('')))
      .stepOnce(resolved(p), signal);

    expect(outcome).toEqual({ kind: 'finished', text: 'hi there' });
    expect(store.messages.at(-1)?.role).toBe('assistant');
    expect(store.steps.map((s) => s.type)).toEqual(['model_call']);
  });

  it('stops after the model call when tools were requested', async () => {
    // One step is ONE model call or ONE tool phase. Doing both would make the
    // step unresumable halfway through.
    seq = 0;
    const store = new FakeStore([message('user', text('book it'))]);
    const p = provider([finish([toolUse('t1', 'calendar__create')])]);
    const g = gateway(() => okResult('booked'));

    const outcome = await runtimeWith(store, g).stepOnce(resolved(p), signal);

    expect(outcome).toEqual({ kind: 'continue', did: 'model_call' });
    expect(g.invocations).toEqual([]);
  });

  it('runs the tool phase on the next step and answers the model', async () => {
    seq = 0;
    const store = new FakeStore([
      message('user', text('book it')),
      message('assistant', [toolUse('t1', 'calendar__create')]),
    ]);
    const g = gateway(() => okResult('booked'));

    const outcome = await runtimeWith(store, g).stepOnce(resolved(provider()), signal);

    expect(outcome).toEqual({ kind: 'continue', did: 'tool_phase' });
    expect(g.invocations).toEqual(['calendar__create']);
    expect(store.messages.at(-1)?.role).toBe('tool');
  });

  it('persists every tool result before the phase can suspend', async () => {
    // This is what makes resumption safe: a side effect already performed is
    // never performed again.
    seq = 0;
    const store = new FakeStore([
      message('user', text('go')),
      message('assistant', [toolUse('t1', 'calendar__create')]),
    ]);
    await runtimeWith(store, gateway(() => okResult('booked')))
      .stepOnce(resolved(provider()), signal);

    expect(store.toolResults.get('t1')?.content).toEqual(text('booked'));
  });
});

describe('resumption', () => {
  it('never re-invokes a tool that already ran', async () => {
    seq = 0;
    const store = new FakeStore([
      message('user', text('go')),
      message('assistant', [toolUse('t1', 'calendar__create'), toolUse('t2', 'calendar__list')]),
    ]);
    store.toolResults.set('t1', {
      id: 't1', canonicalName: 'calendar__create', content: text('already booked'),
      isError: false, durationMs: 1, mrtrRounds: 0,
    });

    const g = gateway(() => okResult('listed'), ['calendar__create', 'calendar__list']);
    await runtimeWith(store, g).stepOnce(resolved(provider()), signal);

    expect(g.invocations).toEqual(['calendar__list']);
    const toolMessage = store.messages.at(-1) as Message;
    expect(toolMessage.content).toHaveLength(2);
  });

  it('suspends without answering the model when a call needs a person', async () => {
    seq = 0;
    const store = new FakeStore([
      message('user', text('go')),
      message('assistant', [toolUse('t1', 'calendar__create')]),
    ]);
    const g = gateway(() => ({
      kind: 'needs_approval', approvalId: 'apr_1' as never, reason: 'writes a calendar',
    }));

    const outcome = await runtimeWith(store, g).stepOnce(resolved(provider()), signal);

    expect(outcome).toEqual({ kind: 'suspended', reason: 'approval', approvalId: 'apr_1' });
    // No tool message yet: the model is still owed a complete set of results.
    expect(store.messages.at(-1)?.role).toBe('assistant');
  });

  it('reads the pending phase from the conversation, not a side record', () => {
    // The conversation IS the state; a second source of truth is a second thing
    // to get out of step.
    seq = 0;
    expect(pendingToolCalls([message('user', text('hi'))])).toBeUndefined();
    expect(pendingToolCalls([message('assistant', text('done'))])).toBeUndefined();
    expect(pendingToolCalls([message('assistant', [toolUse('t1', 'a__x')])]))
      .toEqual([{ id: 't1', canonicalName: 'a__x', input: {} }]);
  });
});

describe('AC-8 — a stopped run still answers', () => {
  it('returns the partial answer when the budget runs out', async () => {
    // The work was paid for either way; an error page throws it away.
    seq = 0;
    const store = new FakeStore([
      message('user', text('go')),
      message('assistant', text('Here is what I found so far.')),
      message('user', text('continue')),
    ]);

    const outcome = await runtimeWith(store, gateway(() => okResult(''))).stepOnce(
      resolved(provider(), { ctx: ctx({ consumed: { ...emptyConsumption, steps: 999 } }) }),
      signal,
    );

    expect(outcome).toMatchObject({
      kind: 'stopped', reason: 'budget', text: 'Here is what I found so far.',
    });
    expect(outcome.kind === 'stopped' && outcome.message).toMatch(/step limit/);
  });

  it('records what was actually spent when it stops', async () => {
    seq = 0;
    const store = new FakeStore([message('user', text('go'))]);
    const p = provider([finish(text('answer'), {
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    })]);

    await runtimeWith(store, gateway(() => okResult(''))).stepOnce(
      resolved(p, { rates: { inputPerMTok: 3, outputPerMTok: 15 } }), signal,
    );

    expect(store.consumption.tokens).toBe(150);
    expect(store.consumption.costUsd).toBeGreaterThan(0);
  });

  it('refuses a tool phase that does not fit, before running any of it', async () => {
    seq = 0;
    const store = new FakeStore([
      message('user', text('go')),
      message('assistant', [toolUse('t1', 'calendar__create'), toolUse('t2', 'calendar__list')]),
    ]);
    const g = gateway(() => okResult('x'), ['calendar__create', 'calendar__list']);

    const outcome = await runtimeWith(store, g).stepOnce(
      resolved(provider(), {
        ctx: ctx({
          budget: { ...DEFAULT_BUDGET, maxToolCalls: 1 },
          consumed: emptyConsumption,
        }),
      }),
      signal,
    );

    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'budget' });
    expect(g.invocations).toEqual([]);
  });
});

describe('stopping conditions', () => {
  it('honours the kill switch before anything is spent', async () => {
    seq = 0;
    const store = new FakeStore([message('user', text('go'))]);
    const g = gateway(() => okResult(''));

    const outcome = await runtimeWith(store, g, {
      killSwitch: { isStopped: async () => 'stopped by an operator' },
    }).stepOnce(resolved(provider([finish(text('never reached'))])), signal);

    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'kill_switch' });
    expect(store.steps).toEqual([]);
  });

  it('stops a loop, and tells the model why in the conversation', async () => {
    seq = 0;
    const store = new FakeStore([
      message('user', text('go')),
      message('assistant', text('working')),
      message('assistant', [toolUse('t3', 'calendar__create')]),
    ]);
    const detector = LoopDetector.from(
      [{ canonicalName: 'calendar__create', args: {} },
       { canonicalName: 'calendar__create', args: {} }],
      { threshold: 3 },
    );
    const g = gateway(() => okResult('x'));

    const outcome = await runtimeWith(store, g, { detector })
      .stepOnce(resolved(provider()), signal);

    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'loop' });
    expect(g.invocations).toEqual([]);
    expect(store.messages.at(-1)?.role).toBe('tool');
  });

  it('records a failed model call as a step before stopping', async () => {
    seq = 0;
    const store = new FakeStore([message('user', text('go'))]);
    const p = provider([{ type: 'error', error: { kind: 'invalid_request', message: 'bad', retryable: false } }]);

    const outcome = await runtimeWith(store, gateway(() => okResult('')))
      .stepOnce(resolved(p), signal);

    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'model_error', message: 'bad' });
    expect(store.steps[0]).toMatchObject({ type: 'model_call', status: 'failed' });
  });
});

describe('compaction is its own step', () => {
  const long = (): Message[] => {
    seq = 0;
    return Array.from({ length: 40 }, (_, i) =>
      ({ ...message(i % 2 === 0 ? 'user' : 'assistant', text('x'.repeat(400))),
         tokenEstimate: 100 }));
  };

  it('compacts instead of calling the model when the history is too long', async () => {
    const store = new FakeStore(long());
    const outcome = await runtimeWith(store, gateway(() => okResult(''))).stepOnce(
      resolved(provider(), { ctx: ctx({ capabilities: capabilities({ maxInputTokens: 1_000 }) }) }),
      signal,
    );

    expect(outcome).toEqual({ kind: 'continue', did: 'compaction' });
    expect(store.steps.map((s) => s.type)).toEqual(['compaction']);
  });

  it('appends the summary before superseding, so a crash leaves no hole', async () => {
    const store = new FakeStore(long());
    await runtimeWith(store, gateway(() => okResult(''))).stepOnce(
      resolved(provider(), { ctx: ctx({ capabilities: capabilities({ maxInputTokens: 1_000 }) }) }),
      signal,
    );

    const summary = store.messages.at(-1) as Message;
    expect(summary.role).toBe('system');
    expect(store.messages.filter((m) => m.supersededBy === summary.id).length).toBeGreaterThan(0);
  });

  it('falls back to a rough summary when the summariser fails', async () => {
    // A summariser that is down must not take the run with it.
    const store = new FakeStore(long());
    await runtimeWith(store, gateway(() => okResult('')), {
      summarise: async () => { throw new Error('summariser is down'); },
    }).stepOnce(
      resolved(provider(), { ctx: ctx({ capabilities: capabilities({ maxInputTokens: 1_000 }) }) }),
      signal,
    );

    expect(store.steps.map((s) => s.type)).toEqual(['compaction']);
    expect(store.messages.at(-1)?.role).toBe('system');
  });
});

describe('provider artifacts', () => {
  it('stores an artifact keyed by the model that produced it', async () => {
    // So a later model drops it rather than replaying state it cannot read.
    seq = 0;
    const store = new FakeStore([message('user', text('go'))]);
    const p = provider([{
      type: 'finish', reason: 'end_turn', content: text('answer'),
      providerArtifacts: { thinking: 'opaque' }, usage: emptyUsage,
    }]);

    await runtimeWith(store, gateway(() => okResult(''))).stepOnce(resolved(p), signal);

    expect(store.messages.at(-1)?.providerArtifacts)
      .toEqual({ [MODEL]: { thinking: 'opaque' } });
  });
});
