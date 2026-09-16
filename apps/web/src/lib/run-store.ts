/**
 * The runtime's state port, over repositories.
 *
 * Every write is LEASE-GUARDED, which is what makes a stolen lease harmless
 * rather than catastrophic: an executor whose lease lapsed mid-step finds its
 * next write refused, so it cannot append a duplicate tool result or a second
 * assistant message for the same turn. The repositories already take the token
 * on the writes that touch the run; the heartbeat covers the rest.
 *
 * The runtime hands this in as a port and never learns there is a database, a
 * collection, or a lease.
 */
import type { Database } from '@salvations/db';
import {
  type ContentBlock, type LeaseToken, type Message, type MessageId, type RunConsumption,
  type Usage,
} from '@salvations/core';
import type {
  AppendMessage, RecordedStep, RunStateStore, ToolInvocationResult,
} from '@salvations/runtime';
import {
  ConversationRepository, MongoRunQueue, RunRepository, toMessage,
} from '@salvations/db';

export interface RunStoreDeps {
  readonly db: Database;
  readonly workspaceId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly leaseToken: LeaseToken;
  readonly leaseMs: number;
  /** What the run had already spent when this slice claimed it. */
  readonly consumedSoFar: RunConsumption;
}

export class MongoRunStateStore implements RunStateStore {
  readonly #conversations: ConversationRepository;
  readonly #runs: RunRepository;
  readonly #queue: MongoRunQueue;
  readonly #deps: RunStoreDeps;
  #lastSaved: RunConsumption;
  #eventSeq = 0;

  constructor(deps: RunStoreDeps) {
    this.#deps = deps;
    this.#conversations = new ConversationRepository(deps.db, deps.workspaceId);
    this.#runs = new RunRepository(deps.db, deps.workspaceId);
    this.#queue = new MongoRunQueue(deps.db);
    this.#lastSaved = deps.consumedSoFar;
  }

  /**
   * Proves this executor still owns the run.
   *
   * Throws `LeaseLostError`, which the executor treats as a stop signal rather
   * than a transient failure. It doubles as the heartbeat: two mechanisms that
   * must agree about liveness are one too many.
   */
  async #guard(): Promise<void> {
    await this.#queue.heartbeat(this.#deps.runId, this.#deps.leaseToken, this.#deps.leaseMs);
  }

  async loadMessages(): Promise<readonly Message[]> {
    // Reads need no guard. Reading with a lost lease is harmless, and requiring
    // one would turn every resume into a write.
    const docs = await this.#conversations.recentMessages(this.#deps.conversationId, 500);
    return docs.map(toMessage);
  }

  async appendMessage(message: AppendMessage): Promise<Message> {
    await this.#guard();
    const doc = await this.#conversations.appendMessage({
      conversationId: this.#deps.conversationId,
      role: message.role,
      content: message.content as unknown[],
      runId: this.#deps.runId,
      ...(message.providerArtifacts !== undefined
        ? { providerArtifacts: message.providerArtifacts as Record<string, unknown> }
        : {}),
      ...(message.tokenEstimate !== undefined ? { tokenEstimate: message.tokenEstimate } : {}),
    });
    return toMessage(doc);
  }

  async supersede(ids: readonly MessageId[], by: MessageId): Promise<void> {
    await this.#guard();
    await this.#conversations.supersedeMessages(
      this.#deps.conversationId, ids.map(String), String(by),
    );
  }

  async recordStep(step: RecordedStep): Promise<void> {
    await this.#runs.appendStep(this.#deps.runId, this.#deps.leaseToken, step as never);
  }

  /**
   * Persists what has been spent.
   *
   * The runtime reports a CUMULATIVE figure and the repository applies an
   * increment, so the difference is computed here. Passing the cumulative value
   * straight through would double-count every step after the first, and the
   * error would compound quietly across a long run.
   */
  async saveConsumption(consumed: RunConsumption, usage: Usage): Promise<void> {
    const delta = {
      steps: consumed.steps - this.#lastSaved.steps,
      toolCalls: consumed.toolCalls - this.#lastSaved.toolCalls,
      tokens: consumed.tokens - this.#lastSaved.tokens,
      costUsd: consumed.costUsd - this.#lastSaved.costUsd,
    };
    this.#lastSaved = consumed;

    await this.#runs.recordConsumption(
      this.#deps.runId, this.#deps.leaseToken, delta, usage,
    );
  }

  /**
   * Results already produced for the in-flight phase.
   *
   * Read from the persisted steps — the same place an operator would look. A
   * separate cache would be a second answer to "did this tool already run", and
   * the two would disagree exactly when it mattered.
   */
  async completedToolCalls(): Promise<ReadonlyMap<string, ToolInvocationResult>> {
    const steps = await this.#runs.listSteps(this.#deps.runId);
    const results = new Map<string, ToolInvocationResult>();

    for (const step of steps) {
      for (const call of step.toolCalls ?? []) {
        const stored = call as unknown as ToolInvocationResult & { content?: ContentBlock[] };
        if (stored.content === undefined) continue;
        results.set(stored.id, stored);
      }
    }
    return results;
  }

  async saveToolResult(result: ToolInvocationResult): Promise<void> {
    await this.#runs.appendStep(this.#deps.runId, this.#deps.leaseToken, {
      type: 'tool_call',
      status: result.isError ? 'failed' : 'succeeded',
      toolCalls: [result],
      latencyMs: result.durationMs,
      startedAt: new Date(),
      finishedAt: new Date(),
    } as never);
  }

  /**
   * Publishes a run event.
   *
   * Not part of the state port: the runtime takes it as a narrow function, so
   * it never learns there is a collection behind it. The sequence is this
   * executor's own counter, and the unique (runId, seq) index turns a second
   * writer into a loud failure rather than a scrambled stream.
   */
  publish = async (type: string, payload: unknown): Promise<void> => {
    await this.#runs.appendEvent(this.#deps.runId, this.#eventSeq++, type, payload);
  };

  /** Continues the event sequence after a slice boundary. */
  resumeEventSeqFrom(seq: number): void {
    this.#eventSeq = seq;
  }
}
