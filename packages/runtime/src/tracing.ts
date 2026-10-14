/**
 * What the runtime needs from a tracer, and no more.
 *
 * A port, so the runtime stays free of the observability package the way it
 * stays free of vendors: the composition root hands in a tracer whose spans
 * end up in an OTLP collector, and a test hands in one that keeps them in an
 * array. The names are fixed here so a dashboard query never breaks on a
 * typo in a call site.
 */

export type TraceAttribute = string | number | boolean;

export interface TraceSpan {
  setAttribute(key: string, value: TraceAttribute): unknown;
  /** Records a failure. The implementation decides what of the error is kept. */
  recordError(error: unknown): unknown;
  end(): void;
}

export interface RunTracer {
  startTrace(name: string, options?: { readonly attributes?: Readonly<Record<string, TraceAttribute>> }): TraceSpan;
  startSpan(parent: TraceSpan, name: string, options?: { readonly attributes?: Readonly<Record<string, TraceAttribute>> }): TraceSpan;
  /** Ships what has been collected. Awaited by the executor before it returns. */
  flush(): Promise<void>;
}

/** The step's place in its run's trace, handed to the runtime for the spans it opens. */
export interface StepTrace {
  readonly tracer: RunTracer;
  readonly span: TraceSpan;
}

export const TRACE = {
  run: 'salvations.run',
  step: 'salvations.step',
  modelCall: 'salvations.model_call',
  toolCall: 'salvations.tool_call',
  compaction: 'salvations.compaction',
} as const;
