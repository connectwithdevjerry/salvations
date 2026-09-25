/**
 * Tracing: run → step → model call | tool call.
 *
 * A run is a tree, and a flat log cannot show why one took ninety seconds. A
 * trace can: the shape alone says whether the time went to the model, to one
 * slow MCP server, or to waiting for a person.
 *
 * WHY THIS IS NOT THE OPENTELEMETRY SDK. The wire format here IS OTLP, so any
 * OTel collector ingests it — what is skipped is the SDK, and deliberately:
 * it brings a large dependency tree into a serverless bundle where cold start
 * is charged per invocation, and its auto-instrumentation has a history of
 * fighting Next.js bundling. The exporter is a port, so swapping the real SDK
 * in later is one adapter and no change above this file. The cost of the
 * choice is that the span model here is the subset we use, not all of OTLP.
 */
import { randomBytes } from 'node:crypto';

export type SpanKind = 'internal' | 'client' | 'server';
export type SpanStatus = 'unset' | 'ok' | 'error';

export type AttributeValue = string | number | boolean;

export interface SpanData {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  /** Unix nanoseconds — OTLP's unit, not milliseconds. */
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly status: SpanStatus;
  readonly statusMessage?: string;
}

/** Where finished spans go. The seam the real SDK would plug into. */
export interface SpanExporter {
  export(spans: readonly SpanData[]): Promise<void>;
}

export const NO_EXPORTER: SpanExporter = { export: async () => undefined };

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');
const nanos = (ms: number): string => `${Math.round(ms * 1_000_000)}`;

export interface SpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
}

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly #parentSpanId: string | undefined;
  readonly #name: string;
  readonly #kind: SpanKind;
  readonly #startMs: number;
  readonly #tracer: Tracer;
  #attributes: Record<string, AttributeValue>;
  #status: SpanStatus = 'unset';
  #statusMessage: string | undefined;
  #ended = false;

  constructor(
    tracer: Tracer,
    name: string,
    ids: { traceId: string; spanId: string; parentSpanId?: string },
    options: SpanOptions,
    startMs: number,
  ) {
    this.#tracer = tracer;
    this.#name = name;
    this.traceId = ids.traceId;
    this.spanId = ids.spanId;
    this.#parentSpanId = ids.parentSpanId;
    this.#kind = options.kind ?? 'internal';
    this.#attributes = { ...options.attributes };
    this.#startMs = startMs;
  }

  setAttribute(key: string, value: AttributeValue): this {
    this.#attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Readonly<Record<string, AttributeValue>>): this {
    this.#attributes = { ...this.#attributes, ...attributes };
    return this;
  }

  /**
   * Records a failure.
   *
   * The message is the error's NAME, not its text: a message can carry a
   * connection string or a prompt, and a span ends up in a third-party backend.
   */
  recordError(error: unknown): this {
    this.#status = 'error';
    this.#statusMessage = error instanceof Error ? error.name : 'unknown';
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    this.#status = status;
    if (message !== undefined) this.#statusMessage = message;
    return this;
  }

  /** Idempotent: ending twice would export the span twice and double every duration. */
  end(endMs?: number): void {
    if (this.#ended) return;
    this.#ended = true;

    this.#tracer.finish({
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.#parentSpanId !== undefined ? { parentSpanId: this.#parentSpanId } : {}),
      name: this.#name,
      kind: this.#kind,
      startTimeUnixNano: nanos(this.#startMs),
      endTimeUnixNano: nanos(endMs ?? this.#tracer.now()),
      attributes: this.#attributes,
      status: this.#status === 'unset' ? 'ok' : this.#status,
      ...(this.#statusMessage !== undefined ? { statusMessage: this.#statusMessage } : {}),
    });
  }
}

export interface TracerOptions {
  readonly exporter?: SpanExporter;
  readonly now?: () => number;
  /** Flushed when this many spans are buffered, so a long run does not grow it forever. */
  readonly maxBuffered?: number;
}

/**
 * Collects spans and flushes them explicitly.
 *
 * Explicitly, because a serverless invocation can be frozen the instant it
 * returns a response: a background flush that has not been awaited simply never
 * happens, and the trace silently disappears. The executor flushes before it
 * returns.
 */
export class Tracer {
  readonly #exporter: SpanExporter;
  readonly #now: () => number;
  readonly #maxBuffered: number;
  #buffer: SpanData[] = [];

  constructor(options: TracerOptions = {}) {
    this.#exporter = options.exporter ?? NO_EXPORTER;
    this.#now = options.now ?? (() => Date.now());
    this.#maxBuffered = options.maxBuffered ?? 512;
  }

  now(): number { return this.#now(); }

  /** Starts a root span — one per run. */
  startTrace(name: string, options: SpanOptions = {}): Span {
    return new Span(
      this, name, { traceId: hex(16), spanId: hex(8) }, options, this.#now(),
    );
  }

  /** Starts a child of an existing span, keeping the trace id. */
  startSpan(parent: Span, name: string, options: SpanOptions = {}): Span {
    return new Span(
      this, name,
      { traceId: parent.traceId, spanId: hex(8), parentSpanId: parent.spanId },
      options, this.#now(),
    );
  }

  /** Called by `Span.end`. Not part of the public surface. */
  finish(span: SpanData): void {
    this.#buffer.push(span);
    // Dropped rather than grown without bound: losing the oldest spans of a
    // runaway run is better than an out-of-memory in the executor.
    if (this.#buffer.length > this.#maxBuffered) this.#buffer.shift();
  }

  get buffered(): number { return this.#buffer.length; }

  /** Ships and clears. Never throws: a trace is not worth failing a run for. */
  async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const spans = this.#buffer;
    this.#buffer = [];
    await this.#exporter.export(spans).catch(() => undefined);
  }
}

/** Span names, in one place so a dashboard query does not break on a typo. */
export const SPAN = {
  run: 'salvations.run',
  step: 'salvations.step',
  modelCall: 'salvations.model_call',
  toolCall: 'salvations.tool_call',
  compaction: 'salvations.compaction',
} as const;
