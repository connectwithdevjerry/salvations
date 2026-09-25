import { describe, expect, it } from 'vitest';
import {
  canonicalNameOf, wireNameOf,
  type AgentSnapshot, type McpBindingId, type ModelCapabilities, type ToolDeclaration,
} from '@salvations/core';
import { selectCapabilities, type SelectionInput } from './capability-selector';

const toolCaps = (over: Partial<ModelCapabilities['tools']> = {}): ModelCapabilities['tools'] => ({
  supported: true, parallelCalls: true, forcedChoice: true,
  namePattern: '^[a-zA-Z0-9_-]{1,64}$', maxNameLength: 64,
  jsonSchemaDialect: '2020-12', strictMode: false,
  ...over,
});

const capabilities = (over: Partial<ModelCapabilities['tools']> = {}): ModelCapabilities =>
  ({ tools: toolCaps(over) }) as ModelCapabilities;

const tool = (name: string): ToolDeclaration => ({
  name, description: '', inputSchema: { type: 'object' },
});

const snapshot = (bindings: AgentSnapshot['capabilityBindings']): AgentSnapshot => ({
  systemPrompt: '', modelRole: 'chat', capabilityBindings: bindings,
  guardrails: { maxToolCallsPerTurn: 8 },
});

const ALIASES = new Map([['calendar', 'bnd_1'], ['crm', 'bnd_2'], ['docs', 'bnd_3']]);

const select = (over: Partial<SelectionInput> = {}) => selectCapabilities({
  available: [tool('calendar__create'), tool('calendar__delete'), tool('crm__lookup')],
  snapshot: snapshot([{ bindingId: 'bnd_1' as McpBindingId, mode: 'all', tools: [] }]),
  capabilities: capabilities(),
  bindingIdByAlias: ALIASES,
  ...over,
});

describe('agent configuration', () => {
  it('shows only the bindings the agent is attached to', () => {
    // A tool available to the workspace is not this agent's tool.
    const selection = select();
    expect(selection.tools.map((t) => t.name))
      .toEqual(['calendar__create', 'calendar__delete']);
    expect(selection.excludedByAgent).toEqual(['crm__lookup']);
  });

  it('resolves a canonical alias to the binding the agent named', () => {
    // The alias in a tool name and the binding id an agent attaches to are
    // different identifiers; matching one against the other admits nothing.
    const selection = select({
      snapshot: snapshot([{ bindingId: 'bnd_2' as McpBindingId, mode: 'all', tools: [] }]),
    });
    expect(selection.tools.map((t) => t.name)).toEqual(['crm__lookup']);
  });

  it('honours an allow list', () => {
    const selection = select({
      snapshot: snapshot([
        { bindingId: 'bnd_1' as McpBindingId, mode: 'allow', tools: ['create'] },
      ]),
    });
    expect(selection.tools.map((t) => t.name)).toEqual(['calendar__create']);
  });

  it('honours a deny list', () => {
    const selection = select({
      snapshot: snapshot([
        { bindingId: 'bnd_1' as McpBindingId, mode: 'deny', tools: ['delete'] },
      ]),
    });
    expect(selection.tools.map((t) => t.name)).toEqual(['calendar__create']);
  });

  it('treats an empty allow list as nothing, not everything', () => {
    // A configuration someone saved half-finished should expose no tools.
    const selection = select({
      snapshot: snapshot([{ bindingId: 'bnd_1' as McpBindingId, mode: 'allow', tools: [] }]),
    });
    expect(selection.tools).toEqual([]);
  });

  it('shows nothing when the agent is attached to nothing', () => {
    expect(select({ snapshot: snapshot([]) }).tools).toEqual([]);
  });

  it('shows nothing to a model that cannot call tools', () => {
    expect(select({ capabilities: capabilities({ supported: false }) }).tools).toEqual([]);
  });
});

describe('model limits', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    tool(`calendar__t${String(i).padStart(2, '0')}`));

  it('truncates deterministically when the model caps the tool count', () => {
    // An unordered truncation shows the model a different set each step, which
    // breaks the prompt cache and makes behaviour irreproducible.
    const first = select({ available: many, capabilities: capabilities({ maxTools: 4 }) });
    const shuffled = select({
      available: [...many].reverse(), capabilities: capabilities({ maxTools: 4 }),
    });

    expect(first.tools.map((t) => t.name)).toEqual(shuffled.tools.map((t) => t.name));
    expect(first.tools).toHaveLength(4);
    expect(first.droppedForLimit).toHaveLength(6);
  });

  it('reports what it dropped, so the omission is visible', () => {
    const selection = select({ available: many, capabilities: capabilities({ maxTools: 2 }) });
    expect(selection.droppedForLimit).toContain('calendar__t09');
  });

  it('sorts the tool list even when nothing is dropped', () => {
    const selection = select({ available: [tool('calendar__z'), tool('calendar__a')] });
    expect(selection.tools.map((t) => t.name)).toEqual(['calendar__a', 'calendar__z']);
  });
});

describe('name mapping', () => {
  it('maps a canonical name to a legal wire name and back', () => {
    const selection = select();
    const wire = wireNameOf(selection.nameMap, 'calendar__create');
    expect(new RegExp(toolCaps().namePattern).test(wire)).toBe(true);
    expect(canonicalNameOf(selection.nameMap, wire)).toBe('calendar__create');
  });

  it('maps only the tools actually shown', () => {
    // A name the model was never given must not resolve, or a hallucinated
    // call would silently reach a real tool.
    const selection = select();
    expect(selection.nameMap.toWire.has('crm__lookup')).toBe(false);
  });

  it('survives a vendor alphabet that rejects the canonical characters', () => {
    const selection = select({
      available: [tool('calendar__read-file.v2')],
      capabilities: capabilities({ namePattern: '^[a-zA-Z_][a-zA-Z0-9_]{0,31}$', maxNameLength: 32 }),
    });
    const wire = wireNameOf(selection.nameMap, 'calendar__read-file.v2');
    expect(/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(wire)).toBe(true);
    expect(canonicalNameOf(selection.nameMap, wire)).toBe('calendar__read-file.v2');
  });
});
