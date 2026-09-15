/**
 * Audit and usage.
 *
 * The audit log is append-only by database grant, not by convention: the
 * application user holds no update or delete privilege on it.
 */
import type { Db } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import { redact } from '@salvations/crypto';
import type { AuditLogDoc, TenantDoc } from '../documents';
import { ScopedDb, type ScopedCollection } from '../scoped';

export interface UsageDailyDoc extends TenantDoc {
  day: string;
  modelBindingId: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  runCount: number;
}

export class AuditRepository {
  readonly #collection: ScopedCollection<AuditLogDoc>;

  constructor(db: Db, workspaceId: string) {
    this.#collection = new ScopedDb(db, workspaceId).collection<AuditLogDoc>('auditLog');
  }

  /**
   * Metadata is redacted HERE rather than by the caller.
   *
   * Every call site would otherwise have to remember, and the one that forgets
   * writes a secret into the one collection that is never deleted.
   */
  async write(entry: {
    actor: { type: string; id?: string };
    action: string;
    subject: { type: string; id?: string };
    metadata?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.#collection.insertOne({
      _id: newId(IdPrefix.auditEntry),
      actor: { type: entry.actor.type, id: entry.actor.id ?? null },
      action: entry.action,
      subject: { type: entry.subject.type, id: entry.subject.id ?? null },
      metadata:
        entry.metadata === undefined
          ? null
          : (redact(entry.metadata) as Record<string, unknown>),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      createdAt: new Date(),
    } as never);
  }

  list(limit = 100, action?: string): Promise<AuditLogDoc[]> {
    return this.#collection.find(
      action === undefined ? ({} as never) : ({ action } as never),
      { sort: { createdAt: -1 }, limit },
    );
  }
}

export class UsageRepository {
  readonly #collection: ScopedCollection<UsageDailyDoc>;
  readonly #workspaceId: string;

  constructor(db: Db, workspaceId: string) {
    this.#collection = new ScopedDb(db, workspaceId).collection<UsageDailyDoc>('usageDaily');
    this.#workspaceId = workspaceId;
  }

  /**
   * Accumulates a run's spend into its day bucket.
   *
   * $inc upsert on a deterministic _id: concurrent runs finishing at once each
   * add their own spend instead of overwriting one another, and billing reads a
   * rollup rather than scanning every run.
   */
  async record(
    modelBindingId: string,
    usage: {
      inputTokens: number; outputTokens: number;
      cacheReadTokens: number; cacheWriteTokens: number;
    },
    costUsd: number,
    when = new Date(),
  ): Promise<void> {
    const day = when.toISOString().slice(0, 10);
    await this.#collection.updateOne(
      { _id: `${this.#workspaceId}:${day}:${modelBindingId}` } as never,
      {
        $inc: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd,
          runCount: 1,
        },
        $setOnInsert: { day, modelBindingId },
      } as never,
      { upsert: true },
    );
  }

  /** Spend today, for the per-workspace daily cost cap. */
  async spendOnDay(day = new Date().toISOString().slice(0, 10)): Promise<number> {
    const rows = await this.#collection.find({ day } as never);
    return rows.reduce((total, row) => total + (row.costUsd ?? 0), 0);
  }

  listDays(limit = 30): Promise<UsageDailyDoc[]> {
    return this.#collection.find({} as never, { sort: { day: -1 }, limit });
  }
}
