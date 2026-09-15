/**
 * What a step needs from storage.
 *
 * Declared here rather than in the domain because the shape is dictated by how
 * a step works, not by what a run IS. The composition root implements it over
 * repositories; the runtime never learns there is a database.
 *
 * Every method is one write or one read. A step persists before the next one
 * begins, which is what lets a run survive a crash, a deploy, or a slice
 * boundary with no authoritative state in the process.
 */
import type {
  CanonicalMessage, ContentBlock, Message, MessageId, ProviderArtifacts, RunConsumption,
  RunStepType, ToolInvocation, Usage,
} from '@salvations/core';

export interface AppendMessage {
  readonly role: Message['role'];
  readonly content: readonly ContentBlock[];
  readonly providerArtifacts?: ProviderArtifacts;
  readonly tokenEstimate?: number;
}

export interface RecordedStep {
  readonly type: RunStepType;
  readonly status: 'succeeded' | 'failed';
  readonly request?: unknown;
  readonly response?: unknown;
  readonly toolCalls?: readonly ToolInvocation[];
  readonly usage?: Usage;
  readonly latencyMs?: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RunStateStore {
  /** Full live history for the conversation, in seq order. */
  loadMessages(): Promise<readonly Message[]>;
  appendMessage(message: AppendMessage): Promise<Message>;
  /** Marks messages as replaced. Edits and compaction append; they never mutate. */
  supersede(ids: readonly MessageId[], by: MessageId): Promise<void>;
  recordStep(step: RecordedStep): Promise<void>;
  /** Written after every step, so a resumed run knows what it has already spent. */
  saveConsumption(consumed: RunConsumption, usage: Usage): Promise<void>;
  /**
   * Results of tool calls already executed for the in-flight phase.
   *
   * Read on resume so a suspended phase replays what it did instead of
   * repeating side effects.
   */
  completedToolCalls(): Promise<ReadonlyMap<string, ToolInvocationResult>>;
  /** Persists a completed call immediately, before the phase can suspend. */
  saveToolResult(result: ToolInvocationResult): Promise<void>;
}

export interface ToolInvocationResult {
  readonly id: string;
  readonly canonicalName: string;
  readonly content: readonly ContentBlock[];
  readonly structured?: unknown;
  readonly isError: boolean;
  readonly bindingId?: string;
  readonly durationMs: number;
  readonly mrtrRounds: number;
}

/** Summarising is a model call; the runtime takes it as a function. */
export type SummariseMessages = (
  messages: readonly CanonicalMessage[],
  signal: AbortSignal,
) => Promise<string>;
