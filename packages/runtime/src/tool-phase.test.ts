import { describe, expect, it } from 'vitest';
import type {
  ApprovalId, McpBindingId, ModelCapabilities, RunContext, ToolGateway, ToolOutcome,
} from '@salvations/core';
import { LoopDetector } from './loop-detection';
import { ToolPhaseRunner, type CompletedCall, type RequestedCall } from './tool-phase';

const ctx = (parallelCalls = true): RunContext =>
  ({ capabilities: { tools: { parallelCalls } } as ModelCapabilities }) as RunContext;

const call = (id: string, name: string, input: unknown = {}): RequestedCall =>
  ({ id, canonicalName: name, input });

const ok = (text: string): ToolOutcome => ({
  kind: 'result',
  content: [{ type: 'text', text }],
  isError: false,
  bindingId: 'bnd_1' as McpBindingId,
  durationMs: 1,
  mrtrRounds: 0,
});

interface FakeGateway extends ToolGateway {
  readonly invocations: string[];
  readonly concurrentPeak: () => number;
}

function gateway(
  responder: (name: string, input: unknown) => ToolOutcome | Promise<ToolOutcome> | never,
): FakeGateway {
  const invocations: string[] = [];
  let inFlight = 0;
  let peak = 0;

  return {
    invocations,
    concurrentPeak: () => peak,
    listAvailable: async () => [],
    invoke: async (name, input) => {
      invocations.push(name);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        // A tick, so genuinely parallel calls overlap and sequential ones do not.
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await responder(name, input);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

const runner = (g: ToolGateway, detector?: LoopDetector) =>
  new ToolPhaseRunner({ gateway: g, ...(detector !== undefined ? { detector } : {}) });

describe('the tool message', () => {
  it('carries a result for every call the model made', async () => {
    // A tool message missing a result is either rejected outright or read as a
    // tool that failed silently, and the model then apologises for nothing.
    const g = gateway((name) => ok(`ran ${name}`));
    const outcome = await runner(g).run(
      [call('t1', 'a__x'), call('t2', 'b__y'), call('t3', 'c__z')], ctx(),
    );

    expect(outcome.kind).toBe('complete');
    expect(outcome.kind === 'complete' && outcome.message).toHaveLength(3);
  });

  it('orders results the way the model asked, not the way they finished', async () => {
    // Several providers match results to calls positionally as well as by id.
    const g = gateway(async (name) => {
      if (name === 'a__slow') await new Promise((r) => setTimeout(r, 20));
      return ok(name);
    });
    const outcome = await runner(g).run(
      [call('t1', 'a__slow'), call('t2', 'b__fast')], ctx(),
    );

    expect(outcome.kind === 'complete' && outcome.completed.map((c) => c.id))
      .toEqual(['t1', 't2']);
  });

  it('marks a failing tool as an error result rather than dropping it', async () => {
    const g = gateway(() => ({ ...ok('boom'), isError: true }));
    const outcome = await runner(g).run([call('t1', 'a__x')], ctx());
    expect(outcome.kind === 'complete' && outcome.message[0]).toMatchObject({
      type: 'tool_result', toolUseId: 't1', isError: true,
    });
  });

  it('turns an infrastructure throw into a result, so the message stays whole', async () => {
    const g = gateway(() => { throw new Error('the database is down'); });
    const outcome = await runner(g).run([call('t1', 'a__x'), call('t2', 'b__y')], ctx());

    expect(outcome.kind === 'complete' && outcome.message).toHaveLength(2);
    expect(outcome.kind === 'complete' && outcome.completed[0]?.isError).toBe(true);
  });

  it('carries structured output through', async () => {
    const g = gateway(() => ({ ...ok('x'), structured: { id: 7 } }));
    const outcome = await runner(g).run([call('t1', 'a__x')], ctx());
    expect(outcome.kind === 'complete' && outcome.message[0])
      .toMatchObject({ structured: { id: 7 } });
  });
});

describe('concurrency', () => {
  it('runs calls in parallel when the model supports it', async () => {
    const g = gateway((name) => ok(name));
    await runner(g).run([call('t1', 'a__x'), call('t2', 'b__y'), call('t3', 'c__z')], ctx(true));
    expect(g.concurrentPeak()).toBeGreaterThan(1);
  });

  it('runs one at a time when it does not', async () => {
    const g = gateway((name) => ok(name));
    await runner(g).run([call('t1', 'a__x'), call('t2', 'b__y')], ctx(false));
    expect(g.concurrentPeak()).toBe(1);
  });

  it('caps parallelism independently of what the model asked for', async () => {
    const g = gateway((name) => ok(name));
    await new ToolPhaseRunner({ gateway: g, maxParallel: 2 }).run(
      Array.from({ length: 6 }, (_, i) => call(`t${i}`, `a__x${i}`)), ctx(true),
    );
    expect(g.concurrentPeak()).toBeLessThanOrEqual(2);
  });
});

describe('suspension', () => {
  const needsApproval: ToolOutcome = {
    kind: 'needs_approval', approvalId: 'apr_1' as ApprovalId, reason: 'writes a calendar',
  };

  it('stops the phase and names the call that is waiting', async () => {
    const g = gateway((name) => (name === 'b__write' ? needsApproval : ok(name)));
    const outcome = await runner(g).run(
      [call('t1', 'a__read'), call('t2', 'b__write')], ctx(false),
    );

    expect(outcome).toMatchObject({
      kind: 'suspended', reason: 'approval', approvalId: 'apr_1', pendingCallId: 't2',
    });
  });

  it('keeps what already ran, so resumption does not repeat a side effect', async () => {
    const g = gateway((name) => (name === 'b__write' ? needsApproval : ok(name)));
    const outcome = await runner(g).run(
      [call('t1', 'a__read'), call('t2', 'b__write')], ctx(false),
    );
    expect(outcome.kind === 'suspended' && outcome.completed.map((c) => c.id)).toEqual(['t1']);
  });

  it('never re-invokes a call that completed before the suspension', async () => {
    // This is the whole reason completed results are passed back in.
    const g = gateway((name) => (name === 'b__write' ? ok(name) : ok(name)));
    const already = new Map<string, CompletedCall>([
      ['t1', {
        id: 't1', canonicalName: 'a__read', content: [{ type: 'text', text: 'from before' }],
        isError: false, durationMs: 1, mrtrRounds: 0,
      }],
    ]);

    const outcome = await runner(g).run(
      [call('t1', 'a__read'), call('t2', 'b__write')], ctx(false), already,
    );

    expect(g.invocations).toEqual(['b__write']);
    expect(outcome.kind === 'complete' && outcome.message[0])
      .toMatchObject({ toolUseId: 't1', content: [{ type: 'text', text: 'from before' }] });
  });

  it('suspends for a server question as input rather than approval', async () => {
    const g = gateway(() => ({
      kind: 'needs_input', approvalId: 'apr_2' as ApprovalId, requestState: 'opaque-state',
    }));
    const outcome = await runner(g).run([call('t1', 'a__x')], ctx());
    expect(outcome).toMatchObject({ kind: 'suspended', reason: 'input', requestState: 'opaque-state' });
  });

  it('suspends for a long-running server task', async () => {
    const g = gateway(() => ({
      kind: 'task_pending', taskId: 'task-1', bindingId: 'bnd_1' as McpBindingId,
    }));
    const outcome = await runner(g).run([call('t1', 'a__x')], ctx());
    expect(outcome).toMatchObject({ kind: 'suspended', reason: 'tool' });
  });
});

describe('loop detection', () => {
  it('refuses a phase that repeats a call, without executing anything', async () => {
    const g = gateway((name) => ok(name));
    const detector = LoopDetector.from(
      [{ canonicalName: 'a__x', args: {} }, { canonicalName: 'a__x', args: {} }],
      { threshold: 3 },
    );

    const outcome = await runner(g, detector).run([call('t1', 'a__x')], ctx());

    expect(outcome.kind).toBe('refused');
    expect(g.invocations).toEqual([]);
  });

  it('tells the model why, once per call it asked for', async () => {
    // A phase whose results simply vanish reads to the model as a broken tool.
    const g = gateway((name) => ok(name));
    const detector = LoopDetector.from(
      [{ canonicalName: 'a__x', args: {} }, { canonicalName: 'a__x', args: {} }],
      { threshold: 3 },
    );

    const outcome = await runner(g, detector).run(
      [call('t1', 'a__x'), call('t2', 'b__y')], ctx(),
    );
    expect(outcome.kind === 'refused' && outcome.message).toHaveLength(2);
    expect(outcome.kind === 'refused' && outcome.message[0])
      .toMatchObject({ type: 'tool_result', isError: true });
  });

  it('records completed calls so a loop is visible on the next phase', async () => {
    const g = gateway((name) => ok(name));
    const detector = new LoopDetector({ threshold: 2 });
    const r = runner(g, detector);

    await r.run([call('t1', 'a__x')], ctx());
    const second = await r.run([call('t2', 'a__x')], ctx());

    expect(second.kind).toBe('refused');
  });
});

describe('events', () => {
  it('publishes a start and a finish for each call', async () => {
    const published: string[] = [];
    const g = gateway((name) => ok(name));
    await new ToolPhaseRunner({
      gateway: g,
      publish: async (type) => { published.push(type); },
    }).run([call('t1', 'a__x')], ctx());

    expect(published).toEqual(['tool_call_started', 'tool_call_finished']);
  });
});
