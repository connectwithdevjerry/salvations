/**
 * OTLP/HTTP JSON export.
 *
 * The wire format an OpenTelemetry collector accepts, written out directly.
 * It is a stable, documented encoding, and emitting it keeps a large SDK out of
 * a serverless bundle — see the note in tracing.ts for why that trade was made.
 *
 * Nothing here fails a run. An exporter that throws would turn a collector
 * outage into an outage of the thing being observed, which is the worst
 * possible failure mode for telemetry.
 */
import type { AttributeValue, SpanData, SpanExporter } from './tracing';

const KIND_CODE: Readonly<Record<SpanData['kind'], number>> = Object.freeze({
  internal: 1, server: 2, client: 3,
});

const STATUS_CODE: Readonly<Record<SpanData['status'], number>> = Object.freeze({
  unset: 0, ok: 1, error: 2,
});

const attributeValue = (value: AttributeValue): Record<string, unknown> => {
  if (typeof value === 'boolean') return { boolValue: value };
  // OTLP distinguishes int from double, and a float sent as intValue is
  // rejected by strict collectors rather than rounded.
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
};

const attributes = (source: Readonly<Record<string, AttributeValue>>) =>
  Object.entries(source).map(([key, value]) => ({ key, value: attributeValue(value) }));

export interface OtlpOptions {
  /** Collector base URL. `/v1/traces` is appended if not already present. */
  readonly endpoint: string;
  readonly serviceName?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  /** Bounded so a wedged collector cannot hold a slice open. */
  readonly timeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

export class OtlpSpanExporter implements SpanExporter {
  readonly #options: Required<Omit<OtlpOptions, 'headers' | 'onError'>> & {
    headers: Readonly<Record<string, string>>;
    onError: (error: unknown) => void;
  };

  constructor(options: OtlpOptions) {
    this.#options = {
      endpoint: options.endpoint.replace(/\/$/, '').endsWith('/v1/traces')
        ? options.endpoint
        : `${options.endpoint.replace(/\/$/, '')}/v1/traces`,
      serviceName: options.serviceName ?? 'salvations',
      fetch: options.fetch ?? globalThis.fetch,
      timeoutMs: options.timeoutMs ?? 3_000,
      headers: options.headers ?? {},
      onError: options.onError ?? (() => undefined),
    };
  }

  async export(spans: readonly SpanData[]): Promise<void> {
    if (spans.length === 0) return;

    const body = {
      resourceSpans: [{
        resource: {
          attributes: attributes({ 'service.name': this.#options.serviceName }),
        },
        scopeSpans: [{
          scope: { name: '@salvations/observability' },
          spans: spans.map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: KIND_CODE[span.kind],
            startTimeUnixNano: span.startTimeUnixNano,
            endTimeUnixNano: span.endTimeUnixNano,
            attributes: attributes(span.attributes),
            status: {
              code: STATUS_CODE[span.status],
              ...(span.statusMessage !== undefined ? { message: span.statusMessage } : {}),
            },
          })),
        }],
      }],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);

    try {
      await this.#options.fetch(this.#options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#options.headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // Swallowed on purpose. A collector outage must not become an outage of
      // the thing being observed.
      this.#options.onError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Keeps spans in memory. For tests, and for a local run with no collector. */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: SpanData[] = [];

  async export(spans: readonly SpanData[]): Promise<void> {
    this.spans.push(...spans);
  }

  /** The tree, for asserting shape rather than order. */
  childrenOf(spanId: string): SpanData[] {
    return this.spans.filter((s) => s.parentSpanId === spanId);
  }

  clear(): void { this.spans.length = 0; }
}
