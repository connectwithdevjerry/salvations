import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter, OtlpSpanExporter } from './otlp';
import { SPAN, Tracer, type SpanData } from './tracing';

function tracer() {
  const exporter = new InMemorySpanExporter();
  let clock = 1_000;
  return {
    exporter,
    tracer: new Tracer({ exporter, now: () => clock }),
    advance: (ms: number) => { clock += ms; },
  };
}

describe('the shape of a run', () => {
  it('nests step and tool spans under the run', async () => {
    // The shape alone says whether time went to the model, to one slow server,
    // or to waiting for a person. A flat log cannot show that.
    const t = tracer();
    const run = t.tracer.startTrace(SPAN.run, { attributes: { 'run.id': 'run_1' } });
    const step = t.tracer.startSpan(run, SPAN.step, { attributes: { 'step.seq': 0 } });
    const tool = t.tracer.startSpan(step, SPAN.toolCall, {
      kind: 'client', attributes: { 'tool.name': 'calendar__create' },
    });

    t.advance(120);
    tool.end();
    step.end();
    run.end();
    await t.tracer.flush();

    const byName = new Map(t.exporter.spans.map((s) => [s.name, s]));
    expect(t.exporter.spans).toHaveLength(3);
    expect(byName.get(SPAN.step)?.parentSpanId).toBe(byName.get(SPAN.run)?.spanId);
    expect(byName.get(SPAN.toolCall)?.parentSpanId).toBe(byName.get(SPAN.step)?.spanId);
  });

  it('keeps one trace id across the whole tree', () => {
    const t = tracer();
    const run = t.tracer.startTrace(SPAN.run);
    const step = t.tracer.startSpan(run, SPAN.step);
    const call = t.tracer.startSpan(step, SPAN.modelCall);

    expect(step.traceId).toBe(run.traceId);
    expect(call.traceId).toBe(run.traceId);
    expect(call.spanId).not.toBe(step.spanId);
  });

  it('records duration in nanoseconds, which is OTLP’s unit', () => {
    const t = tracer();
    const span = t.tracer.startTrace(SPAN.run);
    t.advance(250);
    span.end();

    const [recorded] = t.exporter.spans.length > 0 ? t.exporter.spans : [];
    void recorded;
    // Flushed below, since finish() buffers rather than exports.
    return t.tracer.flush().then(() => {
      const s = t.exporter.spans[0] as SpanData;
      const duration = Number(s.endTimeUnixNano) - Number(s.startTimeUnixNano);
      expect(duration).toBe(250 * 1_000_000);
    });
  });
});

describe('span lifecycle', () => {
  it('defaults a finished span to ok', () => {
    const t = tracer();
    t.tracer.startTrace(SPAN.run).end();
    return t.tracer.flush().then(() => {
      expect(t.exporter.spans[0]?.status).toBe('ok');
    });
  });

  it('records an error by NAME, never its message', async () => {
    // A message can carry a connection string or a prompt, and a span ends up
    // in a third-party backend.
    const t = tracer();
    const span = t.tracer.startTrace(SPAN.modelCall);
    span.recordError(new TypeError('connect ECONNREFUSED 10.0.0.5:27017'));
    span.end();
    await t.tracer.flush();

    expect(t.exporter.spans[0]?.status).toBe('error');
    expect(t.exporter.spans[0]?.statusMessage).toBe('TypeError');
    expect(JSON.stringify(t.exporter.spans)).not.toContain('10.0.0.5');
  });

  it('ignores a second end, which would double every duration', async () => {
    const t = tracer();
    const span = t.tracer.startTrace(SPAN.run);
    span.end();
    span.end();
    await t.tracer.flush();
    expect(t.exporter.spans).toHaveLength(1);
  });

  it('collects attributes added after the span started', async () => {
    const t = tracer();
    const span = t.tracer.startTrace(SPAN.run, { attributes: { 'run.id': 'run_1' } });
    span.setAttribute('run.status', 'succeeded').setAttributes({ 'run.steps': 4 });
    span.end();
    await t.tracer.flush();

    expect(t.exporter.spans[0]?.attributes).toEqual({
      'run.id': 'run_1', 'run.status': 'succeeded', 'run.steps': 4,
    });
  });
});

describe('flushing', () => {
  it('buffers until flushed, because a frozen invocation never runs a callback', async () => {
    // A background flush that has not been awaited simply never happens on a
    // platform that freezes the instant a response returns.
    const t = tracer();
    t.tracer.startTrace(SPAN.run).end();

    expect(t.tracer.buffered).toBe(1);
    expect(t.exporter.spans).toHaveLength(0);

    await t.tracer.flush();
    expect(t.exporter.spans).toHaveLength(1);
    expect(t.tracer.buffered).toBe(0);
  });

  it('is a no-op when there is nothing to send', async () => {
    const t = tracer();
    await expect(t.tracer.flush()).resolves.toBeUndefined();
  });

  it('drops the oldest spans rather than growing without bound', async () => {
    // Losing the start of a runaway run beats an out-of-memory in the executor.
    const exporter = new InMemorySpanExporter();
    const bounded = new Tracer({ exporter, maxBuffered: 10 });
    for (let i = 0; i < 50; i++) bounded.startTrace(`span-${i}`).end();

    expect(bounded.buffered).toBeLessThanOrEqual(11);
    await bounded.flush();
    expect(exporter.spans.at(-1)?.name).toBe('span-49');
  });

  it('never lets an exporter failure reach the caller', async () => {
    // A collector outage must not become an outage of the thing observed.
    const failing = new Tracer({
      exporter: { export: async () => { throw new Error('collector is down'); } },
    });
    failing.startTrace(SPAN.run).end();
    await expect(failing.flush()).resolves.toBeUndefined();
  });
});

describe('OTLP encoding', () => {
  function capture() {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;
    return { sent, fetchFn };
  }

  const spanFixture = (over: Partial<SpanData> = {}): SpanData => ({
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: SPAN.toolCall,
    kind: 'client',
    startTimeUnixNano: '1000000000',
    endTimeUnixNano: '1250000000',
    attributes: { 'tool.name': 'x', 'tool.rounds': 2, 'tool.error': false, 'tool.cost': 0.5 },
    status: 'ok',
    ...over,
  });

  it('appends the traces path when the endpoint omits it', async () => {
    const c = capture();
    await new OtlpSpanExporter({ endpoint: 'https://collector.test', fetch: c.fetchFn })
      .export([spanFixture()]);
    expect(c.sent[0]?.url).toBe('https://collector.test/v1/traces');
  });

  it('does not double the path when it is already there', async () => {
    const c = capture();
    await new OtlpSpanExporter({ endpoint: 'https://collector.test/v1/traces', fetch: c.fetchFn })
      .export([spanFixture()]);
    expect(c.sent[0]?.url).toBe('https://collector.test/v1/traces');
  });

  it('encodes int and double distinctly, which strict collectors require', async () => {
    // A float sent as intValue is rejected rather than rounded.
    const c = capture();
    await new OtlpSpanExporter({ endpoint: 'https://c.test', fetch: c.fetchFn })
      .export([spanFixture()]);

    const attrs = (c.sent[0]?.body as never as {
      resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: { key: string; value: Record<string, unknown> }[] }] }] }];
    }).resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const byKey = new Map(attrs.map((a) => [a.key, a.value]));

    expect(byKey.get('tool.rounds')).toEqual({ intValue: '2' });
    expect(byKey.get('tool.cost')).toEqual({ doubleValue: 0.5 });
    expect(byKey.get('tool.error')).toEqual({ boolValue: false });
    expect(byKey.get('tool.name')).toEqual({ stringValue: 'x' });
  });

  it('sends nothing when there is nothing to send', async () => {
    const c = capture();
    await new OtlpSpanExporter({ endpoint: 'https://c.test', fetch: c.fetchFn }).export([]);
    expect(c.sent).toHaveLength(0);
  });

  it('swallows a collector failure and reports it to the hook', async () => {
    const seen: unknown[] = [];
    const exporter = new OtlpSpanExporter({
      endpoint: 'https://c.test',
      fetch: (() => Promise.reject(new Error('unreachable'))) as typeof globalThis.fetch,
      onError: (error) => seen.push(error),
    });

    await expect(exporter.export([spanFixture()])).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});
