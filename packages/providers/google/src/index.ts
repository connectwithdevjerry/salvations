/**
 * Google adapter.
 *
 * Built against the REST API with plain fetch rather than the vendor SDK, and
 * that is a deliberate deviation worth stating. The SDK exposes no way to inject
 * a fetch implementation — `HTTPClientOptions.fetcher` is internal — so the
 * conformance suite could only reach it by patching globalThis.fetch. Global
 * patching is racy across concurrent cases and tests a path that production does
 * not take. The REST surface here is small and stable, so owning the request
 * costs little and keeps the adapter genuinely testable.
 */
import {
  asProviderType,
  type AgentProvider, type GenerationRequest, type ModelCapabilities,
  type ProviderCredentials, type ProviderEvent, type ProviderType,
} from '@salvations/core';
import { capabilitiesFor, knownModels } from './capabilities';
import { StreamDecoder, encodeRequest, mapError } from './translate';

export const PROVIDER_TYPE: ProviderType = asProviderType('google');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface AdapterOptions extends ProviderCredentials {
  readonly fetch?: typeof globalThis.fetch;
  readonly defaultModel?: string;
}

class GoogleProvider implements AgentProvider {
  readonly providerType = PROVIDER_TYPE;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #defaultModel: string;

  constructor(options: AdapterOptions) {
    this.#apiKey = options.apiKey ?? 'missing';
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#defaultModel = options.defaultModel ?? 'gemini-3.1-pro-preview';
  }

  async describeModel(modelId: string): Promise<ModelCapabilities> {
    return capabilitiesFor(modelId);
  }

  async *generate(
    request: GenerationRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const modelId = modelOf(request, this.#defaultModel);
    const capabilities = capabilitiesFor(modelId);
    const { body, toolNames } = encodeRequest(request, modelId, capabilities);
    const decoder = new StreamDecoder(toolNames);

    try {
      // `alt=sse` is what makes this a stream rather than a single buffered
      // array of chunks.
      const url = `${this.#baseUrl}/models/${modelId}:streamGenerateContent?alt=sse`;
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.#apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        yield { type: 'error', error: mapError(response.status, payload) };
        return;
      }

      for await (const chunk of parseSse(response, signal)) {
        yield* decoder.handle(chunk);
      }

      yield decoder.finish();
    } catch (error) {
      if (signal.aborted) return;
      yield {
        type: 'error',
        error: {
          kind: 'transport',
          message: error instanceof Error ? error.message : 'Provider request failed',
          retryable: true,
          providerRaw: error,
        },
      };
    }
  }
}

/**
 * Minimal SSE reader.
 *
 * Only `data:` lines matter on this transport. Buffering by blank-line boundary
 * is what makes it correct when a chunk boundary falls mid-event — the failure
 * mode otherwise is a JSON parse error under load and nowhere else.
 */
async function* parseSse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const body = response.body;
  if (body === null) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = dataOf(block);
        if (payload !== undefined) yield payload;
        boundary = buffer.indexOf('\n\n');
      }
    }
    const trailing = dataOf(buffer);
    if (trailing !== undefined) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

function dataOf(block: string): Record<string, unknown> | undefined {
  const lines = block.split('\n').filter((l) => l.startsWith('data:'));
  if (lines.length === 0) return undefined;
  const raw = lines.map((l) => l.slice(5).trim()).join('');
  if (raw === '' || raw === '[DONE]') return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function modelOf(request: GenerationRequest, fallback: string): string {
  const declared = (request as { model?: string }).model;
  return typeof declared === 'string' && declared !== '' ? declared : fallback;
}

export const createProvider = (options: AdapterOptions): AgentProvider =>
  new GoogleProvider(options);

export { capabilitiesFor, knownModels };
export { encodeRequest, StreamDecoder, mapError, mapFinishReason, downConvertSchema } from './translate';
