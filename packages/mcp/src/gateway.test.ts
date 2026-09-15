import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry, BlobStore, McpCapability } from '@salvations/core';
import { McpClientManager, type McpServerDefinition } from './client';
import { CircuitOpenError, ToolTimeoutError } from './resilience';
import { DEFAULT_MRTR_POLICY, type MrtrPolicy } from './mrtr';
import { workspaceScope } from './scope';
import {
  ToolGateway, type GatewayDeps, type InvocationContext, type PermissionOutcome, type ToolOutcome,
} from './gateway';

const DEFINITION: McpServerDefinition = {
  bindingId: 'bnd_1',
  serverId: 'srv_1',
  alias: 'calendar',
  transport: 'streamable_http',
  url: 'https://example.test/mcp',
};

const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, attendees: { type: 'integer', minimum: 1 } },
  required: ['title'],
  additionalProperties: false,
} as const;

/** Overrides may set a field to undefined — that is how "no schema" is expressed. */
type CapabilityOverrides = { [K in keyof McpCapability]?: McpCapability[K] | undefined };

function capability(overrides: CapabilityOverrides = {}): McpCapability {
  const base = {
    id: 'cap_1',
    workspaceId: 'ws_1',
    bindingId: 'bnd_1',
    scopeKey: 'workspace',
    kind: 'tool',
    name: 'create_event',
    canonicalName: 'calendar__create_event',
    description: 'Creates a calendar event.',
    inputSchema: SCHEMA,
    definitionHash: 'hash-v1',
    approval: { state: 'approved', definitionHash: 'hash-v1' },
    firstSeenAt: new Date(0),
    lastSeenAt: new Date(0),
  };
  return { ...base, ...overrides } as unknown as McpCapability;
}

const CTX: InvocationContext = {
  workspaceId: 'ws_1',
  runId: 'run_1',
  agentId: 'agt_1',
  principal: { type: 'agent', id: 'agt_1', userId: 'usr_1' },
  callsThisRun: 0,
};

/**
 * A manager whose `run` hands the operation a fake client, so the gateway's own
 * `callTool` argument construction is exercised rather than stubbed out.
 */
class FakeManager extends McpClientManager {
  readonly calls: unknown[] = [];
  #responses: unknown[];

  constructor(responses: unknown[]) {
    super();
    this.#responses = [...responses];
  }

  override async run<T>(
    _definition: McpServerDefinition,
    _scope: never,
    operation: (client: never) => Promise<T>,
  ): Promise<T> {
    const client = {
      callTool: async (request: unknown, options: unknown) => {
        this.calls.push({ request, options });
        const next = this.#responses.shift();
        if (next === undefined) throw new Error('fake manager ran out of scripted responses');
        if (next instanceof Error) throw next;
        return next;
      },
    };
    return operation(client as never);
  }
}

interface Harness {
  readonly gateway: ToolGateway;
  readonly deps: GatewayDeps;
  readonly manager: FakeManager;
  readonly audits: AuditEntry[];
  readonly approvals: { kind: string; payload: unknown }[];
}

function harness(options: {
  capability?: McpCapability | undefined;
  responses?: unknown[];
  permission?: PermissionOutcome;
  mrtrPolicy?: MrtrPolicy;
  blobs?: BlobStore;
  runInference?: GatewayDeps['runInference'];
  auditThrows?: boolean;
} = {}): Harness {
  const audits: AuditEntry[] = [];
  const approvals: { kind: string; payload: unknown }[] = [];
  const manager = new FakeManager(options.responses ?? []);
  const cap = 'capability' in options ? options.capability : capability();

  const deps: GatewayDeps = {
    resolveCapability: async () =>
      cap === undefined
        ? undefined
        : {
            capability: cap,
            definition: DEFINITION,
            scope: workspaceScope('ws_1', 'bnd_1'),
            ...(options.mrtrPolicy !== undefined ? { mrtrPolicy: options.mrtrPolicy } : {}),
          },
    decidePermission: async () => options.permission ?? { effect: 'allow', reason: 'default' },
    requestApproval: async (kind, payload) => {
      approvals.push({ kind, payload });
      return `apr_${approvals.length}`;
    },
    ...(options.runInference !== undefined ? { runInference: options.runInference } : {}),
    manager,
    ...(options.blobs !== undefined ? { blobs: options.blobs } : {}),
    audit: {
      write: async (entry) => {
        if (options.auditThrows === true) throw new Error('audit sink is down');
        audits.push(entry);
      },
    },
  };

  return { gateway: new ToolGateway(deps), deps, manager, audits, approvals };
}

const ok = (text: string) => ({ content: [{ type: 'text', text }] });

const textOf = (outcome: ToolOutcome): string =>
  outcome.kind === 'result'
    ? outcome.result.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
    : `<${outcome.kind}>`;

describe('refusals are results, not exceptions', () => {
  // A thrown error reaches the runtime, not the model. The model then has no
  // idea its call was rejected and simply tries the same thing again.
  it('tells the model when it invented a tool name', async () => {
    const { gateway } = harness();
    const outcome = await gateway.invoke('not_namespaced', {}, CTX);

    expect(outcome.kind).toBe('result');
    expect(outcome.kind === 'result' && outcome.result.isError).toBe(true);
    expect(textOf(outcome)).toMatch(/not a valid tool name/);
  });

  it('tells the model when the tool does not exist for this agent', async () => {
    const { gateway, audits } = harness({ capability: undefined });
    const outcome = await gateway.invoke('calendar__nope', {}, CTX);

    expect(textOf(outcome)).toMatch(/No tool named "calendar__nope"/);
    expect(audits.map((a) => a.action)).toEqual(['mcp.tool.refused']);
  });

  it('never reaches the server when a call is refused', async () => {
    const { gateway, manager } = harness({ capability: undefined });
    await gateway.invoke('calendar__nope', {}, CTX);
    expect(manager.calls).toHaveLength(0);
  });
});

describe('AC-7 — a changed definition blocks the tool', () => {
  it('refuses a capability whose definition changed since approval', async () => {
    // The rug pull: approved at hash-v1, the server now serves something else.
    const { gateway, manager } = harness({
      capability: capability({ definitionHash: 'hash-v2' }),
    });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    expect(textOf(outcome)).toMatch(/definition changed since it was approved/);
    expect(manager.calls).toHaveLength(0);
  });

  it('refuses a capability the server has withdrawn', async () => {
    const { gateway } = harness({ capability: capability({ removedAt: new Date() }) });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);
    expect(textOf(outcome)).toMatch(/no longer offered/);
  });

  it('refuses a capability that was never approved', async () => {
    const { gateway } = harness({
      capability: capability({ approval: { state: 'pending', definitionHash: 'hash-v1' } }),
    });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);
    expect(textOf(outcome)).toMatch(/not been approved/);
  });
});

describe('permission', () => {
  it('explains a denial rather than failing silently', async () => {
    const { gateway, manager, audits } = harness({
      permission: { effect: 'deny', reason: 'read-only agent', matchedRuleId: 'rule_7' },
    });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    expect(textOf(outcome)).toMatch(/Denied by policy \(read-only agent\)/);
    expect(manager.calls).toHaveLength(0);
    expect(audits[0]?.metadata).toMatchObject({ matchedRuleId: 'rule_7' });
  });

  it('suspends for approval without calling the server', async () => {
    const { gateway, manager, approvals, audits } = harness({
      permission: { effect: 'ask', reason: 'writes to a shared calendar' },
    });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    expect(outcome).toEqual({
      kind: 'needs_approval',
      approvalId: 'apr_1',
      reason: 'writes to a shared calendar',
    });
    expect(manager.calls).toHaveLength(0);
    expect(approvals[0]?.kind).toBe('tool_call');
    expect(audits.map((a) => a.action)).toEqual(['mcp.tool.approval_requested']);
  });

  it('hides denied tools from the model entirely', async () => {
    // A tool the model can see is a tool it will try. Offering one that is
    // certain to be refused costs a turn and teaches it that refusal is normal.
    const denied = capability({ canonicalName: 'calendar__delete_all', name: 'delete_all' });
    const { gateway } = harness({
      permission: { effect: 'deny', reason: 'never' },
    });
    expect(await gateway.listAvailable([denied], CTX)).toEqual([]);
  });

  it('hides unusable and non-tool capabilities from the model', async () => {
    const { gateway } = harness();
    const declarations = await gateway.listAvailable(
      [
        capability(),
        capability({ kind: 'prompt', canonicalName: 'calendar__brief' }),
        capability({ canonicalName: 'calendar__stale', definitionHash: 'hash-v2' }),
      ],
      CTX,
    );

    expect(declarations.map((d) => d.name)).toEqual(['calendar__create_event']);
  });
});

describe('argument validation', () => {
  it('refuses arguments the schema rejects, naming every problem at once', async () => {
    // One error per round trip means one wasted model call per wrong field.
    const { gateway, manager } = harness();
    const outcome = await gateway.invoke('calendar__create_event', { attendees: 0 }, CTX);

    expect(textOf(outcome)).toMatch(/Arguments are invalid/);
    expect(textOf(outcome)).toMatch(/title/);
    expect(textOf(outcome)).toMatch(/>= 1/);
    expect(manager.calls).toHaveLength(0);
  });

  it('passes valid arguments through to the server unchanged', async () => {
    const { gateway, manager } = harness({ responses: [ok('created')] });
    const outcome = await gateway.invoke(
      'calendar__create_event', { title: 'Standup', attendees: 3 }, CTX,
    );

    expect(outcome.kind).toBe('result');
    expect(textOf(outcome)).toBe('created');
    expect(manager.calls[0]).toMatchObject({
      // The SERVER's name, not the canonical one: the alias is ours.
      request: { name: 'create_event', arguments: { title: 'Standup', attendees: 3 } },
      options: { allowInputRequired: true },
    });
  });

  it('accepts a tool that declares no schema at all', async () => {
    const { gateway } = harness({
      capability: capability({ inputSchema: undefined }),
      responses: [ok('done')],
    });
    expect(textOf(await gateway.invoke('calendar__create_event', {}, CTX))).toBe('done');
  });
});

describe('results', () => {
  it('audits a successful call with its size and error flag', async () => {
    const { gateway, audits } = harness({
      responses: [{ content: [{ type: 'text', text: 'ok' }], isError: false }],
    });
    await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    const entry = audits.find((a) => a.action === 'mcp.tool.invoked');
    expect(entry?.subject).toEqual({ type: 'mcpCapability', id: 'calendar__create_event' });
    expect(entry?.metadata).toMatchObject({ isError: false, mrtrRounds: 0, runId: 'run_1' });
  });

  it('carries a server-reported error through as an error result', async () => {
    const { gateway } = harness({
      responses: [{ content: [{ type: 'text', text: 'calendar is full' }], isError: true }],
    });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);
    expect(outcome.kind === 'result' && outcome.result.isError).toBe(true);
  });

  it('does not let a failing audit sink take down the call', async () => {
    // Losing the record is bad. Losing the run because the record failed is worse.
    const { gateway } = harness({ responses: [ok('fine')], auditThrows: true });
    expect(textOf(await gateway.invoke('calendar__create_event', { title: 'x' }, CTX))).toBe('fine');
  });
});

describe('failures are contained', () => {
  it('turns a timeout into a result the model can act on', async () => {
    const { gateway, audits } = harness({
      responses: [new ToolTimeoutError('calendar__create_event', 30_000)],
    });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    expect(outcome.kind).toBe('result');
    // It may still be running server-side; saying so stops the model retrying
    // a write it has already performed.
    expect(textOf(outcome)).toMatch(/did not respond in time/);
    expect(audits.map((a) => a.action)).toContain('mcp.tool.failed');
  });

  it('explains an open circuit instead of leaking the breaker', async () => {
    const { gateway } = harness({ responses: [new CircuitOpenError('bnd_1', 5)] });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);
    expect(textOf(outcome)).toMatch(/currently failing and calls to it are paused/);
  });

  it('reports any other transport failure without throwing', async () => {
    const { gateway } = harness({ responses: [new Error('ECONNRESET')] });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);
    expect(textOf(outcome)).toMatch(/ECONNRESET/);
  });
});

const inputRequired = (requests: Record<string, unknown>, requestState?: string) => ({
  resultType: 'input_required',
  inputRequests: requests,
  ...(requestState !== undefined ? { requestState } : {}),
});

const ELICIT = { method: 'elicitation/create', params: { message: 'Which calendar?' } };
const SAMPLE = { method: 'sampling/createMessage', params: { messages: [] } };

describe('AC-15 — MRTR', () => {
  it('refuses an inference request by default, and says why', async () => {
    const { gateway, manager } = harness({ responses: [inputRequired({ s: SAMPLE }, 'st-1')] });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    expect(textOf(outcome)).toMatch(/denied by default/);
    // Refused after one round trip, not retried.
    expect(manager.calls).toHaveLength(1);
  });

  it('refuses rather than answering emptily when inference is allowed but unsampled', async () => {
    // A server handed an empty answer believes it was satisfied.
    const { gateway, manager } = harness({
      responses: [inputRequired({ s: SAMPLE }, 'st-1')],
      mrtrPolicy: { ...DEFAULT_MRTR_POLICY, allowInference: true },
    });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    expect(textOf(outcome)).toMatch(/no sampler is configured/);
    expect(manager.calls).toHaveLength(1);
  });

  it('files sampled answers under the server’s own keys and resumes the call', async () => {
    const runInference = vi.fn(async () => ({ role: 'assistant', content: { type: 'text', text: 'A' } }));
    const { gateway, manager } = harness({
      responses: [inputRequired({ q7: SAMPLE }, 'st-1'), ok('created')],
      mrtrPolicy: { ...DEFAULT_MRTR_POLICY, allowInference: true },
      runInference,
    });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    expect(textOf(outcome)).toBe('created');
    expect(outcome.kind === 'result' && outcome.mrtrRounds).toBe(1);
    expect(runInference).toHaveBeenCalledTimes(1);
    expect(manager.calls[1]).toMatchObject({
      request: {
        // Answers are matched by key, never by order.
        inputResponses: { q7: { role: 'assistant' } },
        // Opaque and echoed back verbatim.
        requestState: 'st-1',
      },
    });
  });

  it('suspends the run for a human question, carrying the state verbatim', async () => {
    const state = 'opaque::server::state::42';
    const { gateway, approvals } = harness({ responses: [inputRequired({ q1: ELICIT }, state)] });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    expect(outcome).toEqual({ kind: 'needs_input', approvalId: 'apr_1', requestState: state });
    expect(approvals[0]?.kind).toBe('mrtr_input');
    expect(approvals[0]?.payload).toMatchObject({
      requests: [{ key: 'q1', kind: 'human' }],
      requestState: state,
    });
  });

  it('never writes the opaque request state into the audit log', async () => {
    // It is minted by a third party and may encode anything, including data we
    // would not choose to retain.
    const state = 'secret-bearing-state';
    const { gateway, audits } = harness({ responses: [inputRequired({ q1: ELICIT }, state)] });
    await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    const entry = audits.find((a) => a.action === 'mcp.tool.input_required');
    expect(entry?.metadata).toMatchObject({ requestState: `len:${state.length}`, kinds: ['human'] });
    expect(JSON.stringify(audits)).not.toContain(state);
  });

  it('refuses the whole round trip if any one request is unacceptable', async () => {
    // A partial answer leaves the server believing it has consent it does not.
    const { gateway } = harness({ responses: [inputRequired({ q1: ELICIT, s: SAMPLE })] });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);
    expect(textOf(outcome)).toMatch(/denied by default/);
  });

  it('stops a server that keeps asking', async () => {
    const runInference = vi.fn(async () => ({}));
    const { gateway, manager } = harness({
      responses: Array.from({ length: 6 }, () => inputRequired({ s: SAMPLE }, 'st')),
      mrtrPolicy: { allowInference: true, allowHumanInput: true, maxRounds: 2 },
      runInference,
    });
    const outcome = await gateway.invoke('calendar__create_event', { title: 'x' }, CTX);

    expect(textOf(outcome)).toMatch(/exceeds the limit of 2/);
    expect(manager.calls).toHaveLength(3);
  });
});
