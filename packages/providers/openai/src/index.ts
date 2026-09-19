/**
 * OpenAI adapter.
 *
 * The only place that knows this vendor's wire format, tool-argument encoding,
 * effort scale and error taxonomy.
 */
import OpenAI, { APIConnectionError, APIError } from 'openai';
import {
  asProviderType,
  type AgentProvider, type CredentialCheck, type GenerationRequest, type ModelCapabilities,
  type ProviderCredentials, type ProviderEvent, type ProviderType,
  type EmbeddingRequest, type EmbeddingResult,
  type TranscriptionRequest, type TranscriptionResult,
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

  /**
   * Speech to text.
   *
   * A dedicated endpoint here, rather than audio pushed through the chat
   * completion: it returns the transcript and nothing else, which is exactly
   * what a transcript should be. Asking a chat model to "transcribe this" gets
   * a transcript wrapped in commentary, or summarised, or answered instead.
   */
  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    try {
      const result = await this.#client.audio.transcriptions.create({
        // Named, because several vendors — this one included — infer the codec
        // from the extension rather than the declared media type.
        file: new File([request.audio], request.fileName, { type: request.mimeType }),
        model: request.modelId,
        // A hint only. Forcing a language turns a bilingual speaker's message
        // into confident nonsense.
        ...(request.languageHint !== undefined ? { language: request.languageHint } : {}),
      });

      return { text: result.text };
    } catch (error) {
      throw mapError(error);
    }
  }

  /** One page of the models list: the cheapest call that needs a valid key. */
  async verify(): Promise<CredentialCheck> {
    try {
      await this.#client.models.list();
      return { ok: true };
    } catch (error) {
      return checkFailure(error);
    }
  }

  /**
   * Text to vectors, for memory and knowledge search by meaning.
   *
   * Inputs go up in one call and come back in the order sent — the vendor
   * numbers each vector, and that index is honoured rather than assumed, so a
   * reordered response could not attach one chunk's vector to another.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    try {
      const result = await this.#client.embeddings.create({
        model: request.modelId,
        input: [...request.inputs],
        encoding_format: 'float',
      });

      const vectors: number[][] = new Array<number[]>(request.inputs.length).fill([]);
      for (const item of result.data) vectors[item.index] = [...item.embedding];

      return {
        vectors,
        dimensions: vectors[0]?.length ?? 0,
        usage: {
          inputTokens: result.usage.prompt_tokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    } catch (error) {
      throw mapError(error);
    }
  }
}

function checkFailure(error: unknown): CredentialCheck {
  if (error instanceof APIConnectionError) {
    return { ok: false, kind: 'unreachable', message: error.message };
  }
  if (error instanceof APIError) {
    const status = error.status ?? 0;
    return { ok: false, kind: 'rejected', message: `${status} ${error.message}`.trim() };
  }
  return { ok: false, kind: 'unreachable', message: error instanceof Error ? error.message : String(error) };
}

function modelOf(request: GenerationRequest, fallback: string): string {
  const declared = (request as { model?: string }).model;
  return typeof declared === 'string' && declared !== '' ? declared : fallback;
}

export const createProvider = (options: AdapterOptions): AgentProvider =>
  new OpenAIProvider(options);

export { capabilitiesFor, knownModels };
export { encodeRequest, StreamDecoder, mapError, mapFinishReason } from './translate';
