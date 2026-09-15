/**
 * Run lifecycle outside the queue.
 *
 * Claiming, leasing and releasing live in MongoRunQueue; this covers creation,
 * reads, step persistence and the event log.
 */
import type { Db } from 'mongodb';
import { IdPrefix, newId, type RunBudget } from '@salvations/core';
import type { ApprovalDoc, RunDoc, RunEventDoc, RunStepDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

export interface CreateRunInput {
  readonly conversationId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly agentSnapshot: RunDoc['agentSnapshot'];
  readonly modelBindingId: string;
  readonly trigger: RunDoc['trigger'];
  readonly principal: unknown;
  readonly budget: RunBudget;
  readonly idempotencyKey?: string;
  readonly parentRunId?: string;
  readonly depth?: number;
  readonly priority?: number;
}

export class RunRepository {
  readonly #runs: ScopedCollection<RunDoc>;
  readonly #steps: ScopedCollection<RunStepDoc>;
  readonly #events: ScopedCollection<RunEventDoc>;
  readonly #approvals: ScopedCollection<ApprovalDoc>;

  constructor(db: Db, workspaceId: string) {
    const scoped = new ScopedDb(db, workspaceId);
    this.#runs = scoped.collection<RunDoc>('runs');
    this.#steps = scoped.collection<RunStepDoc>('runSteps');
    this.#events = scoped.collection<RunEventDoc>('runEvents');
    this.#approvals = scoped.collection<ApprovalDoc>('approvals');
  }

  /**
   * Creates a run, or returns the existing one for the same idempotency key.
   *
   * A retried submission — a double-clicked button, a redelivered webhook —
   * must not start a second run that spends budget and repeats tool calls.
   */
  async create(input: CreateRunInput): Promise<RunDoc> {
    if (input.idempotencyKey !== undefined) {
      const existing = await this.#runs.findOne({
        idempotencyKey: input.idempotencyKey,
      } as never);
      if (existing !== null) return existing;
    }

    const now = new Date();
    const doc = {
      _id: newId(IdPrefix.run),
      conversationId: input.conversationId,
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      agentSnapshot: input.agentSnapshot,
      modelBindingId: input.modelBindingId,
      providerKey: null,
      trigger: input.trigger,
      principal: input.principal,
      status: 'queued',
      priority: input.priority ?? 0,
      scheduledFor: now,
      lease: null,
      attempts: 0,
      continuation: null,
      budget: input.budget,
      consumed: { steps: 0, toolCalls: 0, tokens: 0, wallClockMs: 0, costUsd: 0 },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      nextStepSeq: 1,
      parentRunId: input.parentRunId ?? null,
      depth: input.depth ?? 0,
      idempotencyKey: input.idempotencyKey ?? null,
      error: null,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      heartbeatAt: null,
    };

    try {
      return await this.#runs.insertOne(doc as never);
    } catch (error) {
      // Lost a race on the unique idempotency index: return the winner rather
      // than failing the caller, which is what they wanted anyway.
      if (isDuplicateKey(error) && input.idempotencyKey !== undefined) {
        const existing = await this.#runs.findOne({
          idempotencyKey: input.idempotencyKey,
        } as never);
        if (existing !== null) return existing;
      }
      throw error;
    }
  }

  async findById(runId: string): Promise<RunDoc | null> {
    return this.#runs.findOne({ _id: runId } as never);
  }

  async listForConversation(conversationId: string, limit = 20): Promise<RunDoc[]> {
    return this.#runs.find(
      { conversationId } as never,
      { sort: { queuedAt: -1 }, limit },
    );
  }

  /**
   * Records budget spend.
   *
   * $inc rather than read-modify-write: a slice that reads, computes and writes
   * back would lose the spend of any concurrent step.
   */
  async recordConsumption(
    runId: string,
    leaseToken: string,
    delta: { steps?: number; toolCalls?: number; tokens?: number; costUsd?: number },
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  ): Promise<void> {
    const inc: Record<string, number> = {};
    if (delta.steps !== undefined) inc['consumed.steps'] = delta.steps;
    if (delta.toolCalls !== undefined) inc['consumed.toolCalls'] = delta.toolCalls;
    if (delta.tokens !== undefined) inc['consumed.tokens'] = delta.tokens;
    if (delta.costUsd !== undefined) inc['consumed.costUsd'] = delta.costUsd;
    if (usage !== undefined) {
      inc['usage.inputTokens'] = usage.inputTokens;
      inc['usage.outputTokens'] = usage.outputTokens;
      inc['usage.cacheReadTokens'] = usage.cacheReadTokens;
      inc['usage.cacheWriteTokens'] = usage.cacheWriteTokens;
    }
    // Lease-guarded like every other run write: an executor whose lease was
    // stolen must not keep charging the run it no longer owns.
    await this.#runs.updateOne(
      { _id: runId, 'lease.token': leaseToken } as never,
      { $inc: inc } as never,
    );
  }

  async appendStep(
    runId: string,
    leaseToken: string,
    step: Omit<RunStepDoc, '_id' | 'workspaceId' | 'runId' | 'seq'>,
  ): Promise<RunStepDoc> {
    const before = await this.#runs.findOneAndUpdate(
      { _id: runId, 'lease.token': leaseToken } as never,
      { $inc: { nextStepSeq: 1 } } as never,
      { returnDocument: 'before' },
    );
    if (before === null) {
      throw new Error(`Cannot append a step to run ${runId}: lease not held.`);
    }
    return this.#steps.insertOne({
      _id: newId(IdPrefix.runStep),
      runId,
      seq: before.nextStepSeq,
      ...step,
    } as never);
  }

  async listSteps(runId: string): Promise<RunStepDoc[]> {
    return this.#steps.find({ runId } as never, { sort: { seq: 1 } });
  }

  /**
   * Appends a run event.
   *
   * Sequence comes from the caller's own counter rather than a database read:
   * a single executor owns a run at a time, and the unique (runId, seq) index
   * turns any violation of that assumption into a loud failure.
   */
  async appendEvent(
    runId: string,
    seq: number,
    type: string,
    payload: unknown,
  ): Promise<void> {
    await this.#events.insertOne({
      _id: newId(IdPrefix.runEvent),
      runId,
      seq,
      type,
      payload,
      createdAt: new Date(),
    } as never);
  }

  /** Cursor replay after a dropped SSE connection. */
  async eventsSince(runId: string, afterSeq: number, limit = 500): Promise<RunEventDoc[]> {
    return this.#events.find(
      { runId, seq: { $gt: afterSeq } } as never,
      { sort: { seq: 1 }, limit },
    );
  }

  async createApproval(input: Omit<ApprovalDoc, '_id' | 'workspaceId'>): Promise<ApprovalDoc> {
    return this.#approvals.insertOne({ _id: newId(IdPrefix.approval), ...input } as never);
  }

  /**
   * Records a decision, once.
   *
   * The `decision: null` guard makes this idempotent: a double-clicked Approve
   * cannot overwrite a Deny, and two reviewers racing cannot both win.
   */
  async decideApproval(
    approvalId: string,
    decision: 'approve' | 'deny',
    decidedBy: string,
    response?: unknown,
  ): Promise<boolean> {
    const result = await this.#approvals.updateOne(
      { _id: approvalId, decision: null } as never,
      {
        $set: {
          decision,
          decidedBy,
          decidedAt: new Date(),
          ...(response !== undefined ? { response } : {}),
        },
      } as never,
    );
    return result.matchedCount === 1;
  }

  async pendingApprovals(limit = 50): Promise<ApprovalDoc[]> {
    return this.#approvals.find(
      { decision: null } as never,
      { sort: { requestedAt: -1 }, limit },
    );
  }

  async findApproval(approvalId: string): Promise<ApprovalDoc | null> {
    return this.#approvals.findOne({ _id: approvalId } as never);
  }
}

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
