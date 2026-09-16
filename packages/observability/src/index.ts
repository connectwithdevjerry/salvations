/**
 * @salvations/observability — metrics and tracing helpers.
 *
 * Ports and pure aggregation only; an exporter binds at the composition root.
 */
export {
  InMemoryMetrics, NO_METRICS, type MetricName, type MetricRecorder,
} from './metrics';

export { ExecutionMetricsRecorder } from './execution-metrics';
