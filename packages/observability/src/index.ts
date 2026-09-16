/**
 * @salvations/observability — metrics and tracing helpers.
 *
 * Ports and pure aggregation only; an exporter binds at the composition root.
 */
export {
  InMemoryMetrics, NO_METRICS, type MetricName, type MetricRecorder,
} from './metrics';

export { ExecutionMetricsRecorder } from './execution-metrics';

export {
  NO_LOGGER, consoleSink, createLogger,
  type LogRecord, type LogSink, type LoggerOptions,
} from './logging';

export {
  NO_EXPORTER, SPAN, Span, Tracer,
  type AttributeValue, type SpanData, type SpanExporter, type SpanKind, type SpanOptions,
  type SpanStatus, type TracerOptions,
} from './tracing';

export { InMemorySpanExporter, OtlpSpanExporter, type OtlpOptions } from './otlp';
