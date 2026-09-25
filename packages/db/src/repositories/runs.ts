/**
 * Run lifecycle outside the queue.
 *
 * Claiming, leasing and releasing live in MongoRunQueue; this covers creation,
 * reads, step persistence and the event log.
 */
import type { Db } from 'mongodb';
import type { Principal } from '@salvations/core';
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
  /**
   * Typed, not `unknown`.
   *
   * It was `unknown` because the document only stores it, and the cost of that
   * showed up immediately: a caller invented a principal shape of its own and
   * nothing objected until it reached the code that reads one back. A run's
   * principal is the whole of its authority — the one field that must not be
   * whatever the caller felt like passing.
   */
  readonly principal: Principal;
  readonly budget: RunBudget;
  readonly idempotencyKey?: string;
  readonly parentRunId?: string;
  readonly depth?: number;
  readonly priority?: number;
}

export interface RunSummaryRow {
  readonly status: string;
  readonly agentId: string;
  readonly queuedAt: Date;
  readonly costUsd: number;
  readonly trigger: string;
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
   * Recent runs across the whole workspace.
   *
   * Sorted by `queuedAt` and not by finish time, so a run still working appears
   * where you would look for it rather than at the bottom under everything that
   * has already finished.
   */
  /**
   * The runs since a moment, cut down to what a summary needs. Read with a
   * projection, so a busy week does not load every snapshot and budget to
   * count outcomes and add up spend.
   */
  async summarySince(since: Date, limit = 5_000): Promise<RunSummaryRow[]> {
    const rows = await this.#runs.find(
      { queuedAt: { $gte: since } } as never,
      { sort: { queuedAt: -1 }, limit, projection: { status: 1, agentId: 1, queuedAt: 1, 'consumed.costUsd': 1, 'trigger.type': 1 } },
    );
    return rows.map((row) => ({
      status: row.status,
      agentId: row.agentId,
      queuedAt: row.queuedAt,
      costUsd: row.consumed?.costUsd ?? 0,
      trigger: row.trigger?.type ?? 'unknown',
    }));
  }

  async listRecent(limit = 50, status?: string): Promise<RunDoc[]> {
    return this.#runs.find(
      (status === undefined ? {} : { status }) as never,
      { sort: { queuedAt: -1 }, limit },
    );
  }

  /**
   * Records budget spend.
   *
   * $inc rather than read-modify-write: a slice that reads, computes and writes
   * back would lose the spend of any concurrent step.
   */
  /**
   * Adds spend to a run.
   *
   * BOTH arguments are DELTAS, and both parameter names say so. Every field
   * here is applied with `$inc`, while the runtime reports its figures
   * cumulatively — so handing this a running total charges the run the sum of
   * every step's total instead of the total. The mistake is easy to make and
   * hard to see afterwards, because the numbers still look plausible.
   */
  async recordConsumption(
    runId: string,
    leaseToken: string,
    consumedDelta: { steps?: number; toolCalls?: number; tokens?: number; costUsd?: number },
    usageDelta?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  ): Promise<void> {
    const inc: Record<string, number> = {};
    if (consumedDelta.steps !== undefined) inc['consumed.steps'] = consumedDelta.steps;
    if (consumedDelta.toolCalls !== undefined) inc['consumed.toolCalls'] = consumedDelta.toolCalls;
    if (consumedDelta.tokens !== undefined) inc['consumed.tokens'] = consumedDelta.tokens;
    if (consumedDelta.costUsd !== undefined) inc['consumed.costUsd'] = consumedDelta.costUsd;
    if (usageDelta !== undefined) {
      inc['usage.inputTokens'] = usageDelta.inputTokens;
      inc['usage.outputTokens'] = usageDelta.outputTokens;
      inc['usage.cacheReadTokens'] = usageDelta.cacheReadTokens;
      inc['usage.cacheWriteTokens'] = usageDelta.cacheWriteTokens;
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

  /**
   * Cancels a run.
   *
   * Marks it, rather than interrupting anything: the executor is elsewhere and
   * possibly mid-tool-call. The lease is deliberately left alone — an executor
   * that still holds one finishes its current step and finds the run cancelled
   * on the next, which is the only point at which stopping is safe.
   */
  async cancel(runId: string): Promise<boolean> {
    const result = await this.#runs.updateOne(
      {
        _id: runId,
        status: { $nin: ['succeeded', 'failed', 'cancelled', 'expired'] },
      } as never,
      { $set: { status: 'cancelled', finishedAt: new Date() } } as never,
    );
    return result.matchedCount === 1;
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
