/**
 * Anthropic adapter.
 *
 * The ONLY place in the codebase that knows how this vendor works. Everything
 * it absorbs — wire shapes, reasoning configuration, cache markers, tool name
 * limits, error taxonomy, artifact replay — is invisible to the runtime.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  asProviderType, providerKey,
  type AgentProvider, type GenerationRequest, type ModelCapabilities,
  type ProviderCredentials, type ProviderEvent, type ProviderType, type TokenCount,
} from '@salvations/core';
import { capabilitiesFor, knownModels } from './capabilities';
import { encodeRequest } from './encode';
import { StreamDecoder, mapError } from './decode';

export const PROVIDER_TYPE: ProviderType = asProviderType('anthropic');

export interface AdapterOptions extends ProviderCredentials {
  /** Injected for tests, so the conformance suite drives real SDK parsing. */
  readonly fetch?: typeof globalThis.fetch;
  readonly defaultModel?: string;
}

class AnthropicProvider implements AgentProvider {
  readonly providerType = PROVIDER_TYPE;
  readonly #client: Anthropic;
  readonly #defaultModel: string;

  constructor(options: AdapterOptions) {
    this.#client = new Anthropic({
      apiKey: options.apiKey ?? 'missing',
      ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      // The runtime owns retry policy, because only it knows the run's budget
      // and its slice deadline. A retry hidden inside the SDK can overrun both.
      maxRetries: 0,
    });
    this.#defaultModel = options.defaultModel ?? 'claude-opus-5';
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
    const decoder = new StreamDecoder(toolNames, providerKey('anthropic', modelId));

    let sawFinish = false;
    try {
      // The SDK discriminates streaming on a LITERAL `stream: true`, which a
      // dynamically-assembled body cannot express, so the overload resolves to
      // the non-streaming shape. The body does set stream: true (encode.ts).
      const stream = (await this.#client.messages.create(body as never, { signal })) as unknown as
        AsyncIterable<Record<string, unknown>>;

      for await (const raw of stream) {
        for (const event of decoder.handle(raw)) {
          if (event.type === 'finish') sawFinish = true;
          yield event;
        }
      }

      // A stream that ends without a terminal event still has content worth
      // keeping; emitting the accumulated state beats discarding it.
      if (!sawFinish) yield decoder.finish();
    } catch (error) {
      if (signal.aborted) return;
      // Reported as an EVENT, not a throw: the runtime folds this stream, and a
      // throw mid-iteration discards whatever was already emitted — including
      // usage that still has to be billed.
      yield { type: 'error', error: mapError(error) };
    }
  }

  async countTokens(request: GenerationRequest): Promise<TokenCount> {
    const modelId = modelOf(request, this.#defaultModel);
    const capabilities = capabilitiesFor(modelId);
    const { body } = encodeRequest(request, modelId, capabilities);
    const { stream: _stream, max_tokens: _max, ...countable } = body;
    const result = await this.#client.messages.countTokens(countable as never);
    return { inputTokens: result.input_tokens };
  }
}

/**
 * The model is carried on the request rather than baked into the adapter, so a
 * single configured provider serves every model binding that points at it.
 */
function modelOf(request: GenerationRequest, fallback: string): string {
  const declared = (request as { model?: string }).model;
  return typeof declared === 'string' && declared !== '' ? declared : fallback;
}

export const createProvider = (options: AdapterOptions): AgentProvider =>
  new AnthropicProvider(options);

export { capabilitiesFor, knownModels };
export { encodeRequest } from './encode';
export { StreamDecoder, mapError, mapStopReason, mapUsage } from './decode';
