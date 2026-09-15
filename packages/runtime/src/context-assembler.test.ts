import { describe, expect, it } from 'vitest';
import {
  canonicalJson, providerKey,
  type Message, type ModelCapabilities, type RunContext, type SystemDirective,
  type ToolDeclaration,
} from '@salvations/core';
import {
  assemblePrompt, estimateTokens, prefixIsPreserved, type AssembleInput,
} from './context-assembler';

const MODEL = providerKey('anthropic', 'claude-x-1');

const capabilities = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  modelId: 'claude-x-1',
  maxInputTokens: 200_000,
  maxOutputTokens: 8_192,
  tools: {
    supported: true, parallelCalls: true, forcedChoice: true,
    namePattern: '^[a-zA-Z0-9_-]{1,64}$', maxNameLength: 64,
    jsonSchemaDialect: '2020-12', strictMode: false,
  },
  reasoning: {
    supported: true, mode: 'budget', artifactsMustReplay: true, artifactsPortable: false,
  },
  promptCache: {
    supported: true, strategy: 'explicit_breakpoints', maxBreakpoints: 4, minPrefixTokens: 1024,
  },
  structuredOutput: { supported: true, mechanism: 'tool' },
  modalities: { imageInput: true, documentInput: true, audioInput: false },
  assistantPrefill: false,
  systemMessagePlacement: 'top_level',
  streaming: true,
  ...over,
});

const ctx = (over: Partial<ModelCapabilities> = {}): AssembleInput['ctx'] => ({
  runId: 'run_1' as RunContext['runId'],
  workspaceId: 'ws_1' as RunContext['workspaceId'],
  agentId: 'agt_1' as RunContext['agentId'],
  providerKey: MODEL,
  capabilities: capabilities(over),
});

const message = (seq: number, over: Partial<Message> = {}): Message => ({
  id: `msg_${seq}` as Message['id'],
  conversationId: 'cnv_1' as Message['conversationId'],
  seq,
  role: seq % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: `turn ${seq}` }],
  createdAt: new Date(seq * 1000),
  ...over,
});

const tool = (name: string): ToolDeclaration => ({
  name, description: `does ${name}`, inputSchema: { type: 'object' },
});

const history = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => message(i));

const input = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  ctx: ctx(),
  directives: [{ kind: 'identity', text: 'You are an assistant.' }],
  messages: history(6),
  tools: [tool('calendar__create'), tool('crm__lookup')],
  maxOutputTokens: 4096,
  ...over,
});

describe('🔒 (I9) the cacheable prefix is stable', () => {
  it('does not depend on the order tools were discovered in', () => {
    // Discovery order depends on which MCP server answered first.
    const a = assemblePrompt(input({ tools: [tool('a__x'), tool('b__y'), tool('c__z')] }));
    const b = assemblePrompt(input({ tools: [tool('c__z'), tool('a__x'), tool('b__y')] }));

    expect(a.prefixFingerprint).toBe(b.prefixFingerprint);
    expect(canonicalJson(a.request.tools)).toBe(canonicalJson(b.request.tools));
  });

  it('does not depend on the order directives were added in', () => {
    const directives: SystemDirective[] = [
      { kind: 'identity', text: 'I' }, { kind: 'memory', text: 'M' },
      { kind: 'policy', text: 'P' }, { kind: 'safety', text: 'S' },
    ];
    const a = assemblePrompt(input({ directives }));
    const b = assemblePrompt(input({ directives: [...directives].reverse() }));

    expect(a.prefixFingerprint).toBe(b.prefixFingerprint);
    // The declared order, not either caller's.
    expect(a.request.system.map((d) => d.kind)).toEqual(['identity', 'policy', 'safety', 'memory']);
  });

  it('does not depend on the order history came back from the database', () => {
    const messages = history(6);
    const a = assemblePrompt(input({ messages }));
    const b = assemblePrompt(input({ messages: [...messages].reverse() }));

    expect(a.prefixFingerprint).toBe(b.prefixFingerprint);
    expect(canonicalJson(a.request.messages)).toBe(canonicalJson(b.request.messages));
  });

  it('extends the cached prefix when a turn is appended, never mutates it', () => {
    // This is the invariant a cache actually needs. It is weaker than "the
    // prefix is identical" — a cache is EXTENDED every step — and stronger
    // than nothing: a reordered tool or an edited message inside the cached
    // region invalidates every entry written so far.
    const before = assemblePrompt(input({ messages: history(6) }));
    const after = assemblePrompt(input({ messages: [...history(6), message(6), message(7)] }));

    expect(prefixIsPreserved(before, after)).toBe(true);
  });

  it('keeps the anchor fingerprint fixed as history grows within a stride', () => {
    // The trailing breakpoint advances every step; the anchor must not, or the
    // entry written under it is never read back.
    const at = (n: number) => assemblePrompt(input({ messages: history(n) }));
    const base = at(12);
    expect(base.request.cacheHints?.breakpointsAfter).toHaveLength(2);

    for (const n of [13, 14, 15, 16]) {
      expect(at(n).prefixFingerprint).toBe(base.prefixFingerprint);
      expect(prefixIsPreserved(base, at(n))).toBe(true);
    }
  });

  it('notices a mutation inside the cached region', () => {
    // An edit to old history is exactly the case that must NOT read as
    // preserved: every entry written so far is dead.
    const before = assemblePrompt(input({ messages: history(12) }));
    const edited = history(12);
    edited[1] = message(1, { content: [{ type: 'text', text: 'rewritten' }] });
    const after = assemblePrompt(input({ messages: [...edited, message(12)] }));

    expect(prefixIsPreserved(before, after)).toBe(false);
  });

  it('notices a reordered tool list as a mutation', () => {
    const before = assemblePrompt(input({ messages: history(12) }));
    const after = assemblePrompt(input({
      messages: history(12),
      tools: [tool('calendar__create'), tool('crm__lookup'), tool('docs__read')],
    }));
    expect(prefixIsPreserved(before, after)).toBe(false);
  });

  it('reports a changed fingerprint when a tool is added', () => {
    // Silently reusing a fingerprint across different tool sets would make the
    // diagnostic useless.
    const before = assemblePrompt(input());
    const after = assemblePrompt(input({ tools: [...input().tools, tool('docs__read')] }));
    expect(after.prefixFingerprint).not.toBe(before.prefixFingerprint);
  });

  it('is identical across two runs of the same agent', () => {
    // The run id is metadata, not prefix: two runs of one agent share a cache.
    const a = assemblePrompt(input());
    const b = assemblePrompt(input({
      ctx: { ...ctx(), runId: 'run_2' as RunContext['runId'] },
    }));
    expect(a.prefixFingerprint).toBe(b.prefixFingerprint);
  });

  it('produces a byte-identical request for identical input', () => {
    expect(canonicalJson(assemblePrompt(input()).request))
      .toBe(canonicalJson(assemblePrompt(input()).request));
  });
});

describe('history', () => {
  it('drops a superseded message rather than sending an edit twice', () => {
    const messages = [
      message(0, { supersededBy: 'msg_9' as Message['id'] }),
      message(1), message(2),
    ];
    const { request } = assemblePrompt(input({ messages }));
    expect(request.messages).toHaveLength(2);
  });

  it('drops an empty directive, which would otherwise split two agents’ caches', () => {
    const { request } = assemblePrompt(input({
      directives: [{ kind: 'identity', text: 'I' }, { kind: 'policy', text: '   ' }],
    }));
    expect(request.system).toHaveLength(1);
  });
});

describe('provider artifacts', () => {
  const withArtifacts = (key: string) =>
    message(1, { providerArtifacts: { [key]: { thinking: 'opaque-blob' } } });

  it('replays an artifact verbatim for the model that produced it', () => {
    const { request, droppedArtifacts } = assemblePrompt(input({
      messages: [message(0), withArtifacts(MODEL)],
    }));

    expect(request.messages[1]?.providerArtifacts).toEqual({
      [MODEL]: { thinking: 'opaque-blob' },
    });
    expect(droppedArtifacts).toBe(0);
  });

  it('drops an artifact from a different model', () => {
    // Replaying foreign reasoning state is rejected by some vendors and
    // silently corrupts continuation on others.
    const { request, droppedArtifacts } = assemblePrompt(input({
      messages: [message(0), withArtifacts(providerKey('openai', 'gpt-x'))],
    }));

    expect(request.messages[1]?.providerArtifacts).toBeUndefined();
    expect(droppedArtifacts).toBe(1);
  });

  it('keeps the canonical content when the artifact is dropped', () => {
    // The conversation continues; only the vendor-private state is lost.
    const { request } = assemblePrompt(input({
      messages: [message(0), withArtifacts(providerKey('google', 'gemini-x'))],
    }));
    expect(request.messages[1]?.content).toEqual([{ type: 'text', text: 'turn 1' }]);
  });
});

describe('cache breakpoints', () => {
  it('places none for a model that does not cache', () => {
    const { request } = assemblePrompt(input({
      ctx: ctx({ promptCache: { supported: false, strategy: 'none' } }),
    }));
    expect(request.cacheHints).toBeUndefined();
  });

  it('places none for a model that caches automatically', () => {
    // Paying the explicit-breakpoint premium where the vendor caches for free.
    const { request } = assemblePrompt(input({
      ctx: ctx({ promptCache: { supported: true, strategy: 'automatic' } }),
    }));
    expect(request.cacheHints).toBeUndefined();
  });

  it('leaves the volatile tail outside the breakpoint', () => {
    const { request } = assemblePrompt(input({ messages: history(6) }));
    const last = request.cacheHints?.breakpointsAfter.at(-1) as number;
    expect(last).toBe(3);
    expect(last).toBeLessThan(request.messages.length - 1);
  });

  it('places none when the history is too short to have a stable part', () => {
    const { request } = assemblePrompt(input({ messages: history(2) }));
    expect(request.cacheHints).toBeUndefined();
  });

  it('places a second, earlier breakpoint when the model allows more than one', () => {
    // Keeps a hit possible once the tail grows past the first one.
    const { request } = assemblePrompt(input({ messages: history(12) }));
    // Anchor at 7 (a multiple of the stride, minus one) and the trailing edge.
    expect(request.cacheHints?.breakpointsAfter).toEqual([7, 9]);
  });

  it('places only one when the model allows only one', () => {
    const { request } = assemblePrompt(input({
      messages: history(12),
      ctx: ctx({
        promptCache: { supported: true, strategy: 'explicit_breakpoints', maxBreakpoints: 1 },
      }),
    }));
    expect(request.cacheHints?.breakpointsAfter).toHaveLength(1);
  });
});

describe('token estimation', () => {
  it('counts nested tool results', () => {
    const nested = estimateTokens([
      { type: 'tool_result', toolUseId: 't1', isError: false,
        content: [{ type: 'text', text: 'x'.repeat(400) }] },
    ]);
    expect(nested).toBe(100);
  });

  it('counts a spilled blob by its reference, not its payload', () => {
    // The payload is not in the prompt, so charging for it would compact a
    // conversation that fits comfortably.
    const estimate = estimateTokens([
      { type: 'blob_ref', key: 'runs/r/result.json', bytes: 5_000_000, mime: 'application/json' },
    ]);
    expect(estimate).toBeLessThan(10);
  });
});
