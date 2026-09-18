/**
 * The vendor seam.
 *
 * NO SDK import is permitted in this file, ever. Differences between vendors are
 * expressed as ModelCapabilities (data the runtime reads) and as behaviour inside
 * adapters the runtime cannot see.
 */
import type {
  EmbeddingRequest, EmbeddingResult, GenerationRequest, ModelCapabilities,
  ProviderEvent, ProviderType, TokenCount, TranscriptionRequest, TranscriptionResult,
} from '../entities/model';

export interface AgentProvider {
  readonly providerType: ProviderType;

  describeModel(modelId: string): Promise<ModelCapabilities>;

  /** Always streaming. A non-streaming call is a fold over this; the reverse is impossible. */
  generate(req: GenerationRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;

  countTokens?(req: GenerationRequest): Promise<TokenCount>;
  embed?(req: EmbeddingRequest): Promise<EmbeddingResult>;

  /**
   * Optional, like the two above, because not every vendor does it.
   *
   * Optional rather than a method that throws: a caller can check whether the
   * capability is there before offering it to somebody, instead of discovering
   * at the moment of use that this workspace's provider cannot hear.
   */
  transcribe?(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface ProviderCredentials {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly extra?: Readonly<Record<string, string>>;
  /**
   * Overrides how requests leave the process.
   *
   * Not only a test seam: an egress proxy, request instrumentation, or a
   * per-workspace network policy all need this hook, and without it each
   * adapter would grow its own bespoke escape hatch.
   */
  readonly fetch?: typeof globalThis.fetch;
}

export interface AgentProviderFactory {
  readonly providerType: ProviderType;
  create(credentials: ProviderCredentials): AgentProvider;
}

/** Resolves a provider adapter. The registry, not core, knows which types exist. */
export interface ProviderRegistry {
  has(providerType: ProviderType): boolean;
  create(providerType: ProviderType, credentials: ProviderCredentials): AgentProvider;
  knownTypes(): readonly ProviderType[];
}
