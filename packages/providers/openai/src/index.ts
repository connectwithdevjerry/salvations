/**
 * OpenAI adapter.
 *
 * The only place that knows this vendor's wire format, tool-argument encoding,
 * effort scale and error taxonomy.
 */
import OpenAI from 'openai';
import {
  asProviderType,
  type AgentProvider, type GenerationRequest, type ModelCapabilities,
  type ProviderCredentials, type ProviderEvent, type ProviderType,
} from '@salvations/core';
import { capabilitiesFor, knownModels } from './capabilities';
import { StreamDecoder, encodeRequest, mapError } from './translate';

export const PROVIDER_TYPE: ProviderType = asProviderType('openai');

export interface AdapterOptions extends ProviderCredentials {
  readonly fetch?: typeof globalThis.fetch;
  readonly defaultModel?: string;
}

class OpenAIProvider implements AgentProvider {
  readonly providerType = PROVIDER_TYPE;
  readonly #client: OpenAI;
  readonly #defaultModel: string;

  constructor(options: AdapterOptions) {
    this.#client = new OpenAI({
      apiKey: options.apiKey ?? 'missing',
      ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      // Retry policy belongs to the runtime, which knows the budget and the
      // slice deadline; a hidden retry can overrun both.
      maxRetries: 0,
    });
    this.#defaultModel = options.defaultModel ?? 'gpt-5.6-sol';
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
      // The SDK discriminates streaming on a literal `stream: true`, which a
      // dynamically-assembled body cannot express; the body does set it.
      const stream = (await this.#client.chat.completions.create(body as never, { signal })) as
        unknown as AsyncIterable<Record<string, unknown>>;

      for await (const chunk of stream) {
        yield* decoder.handle(chunk);
      }

      // There is no terminal event on this transport — the stream simply ends
      // — so the finish event is always synthesised here.
      yield decoder.finish();
    } catch (error) {
      if (signal.aborted) return;
      yield { type: 'error', error: mapError(error) };
    }
  }
}

function modelOf(request: GenerationRequest, fallback: string): string {
  const declared = (request as { model?: string }).model;
  return typeof declared === 'string' && declared !== '' ? declared : fallback;
}

export const createProvider = (options: AdapterOptions): AgentProvider =>
  new OpenAIProvider(options);

export { capabilitiesFor, knownModels };
export { encodeRequest, StreamDecoder, mapError, mapFinishReason } from './translate';
