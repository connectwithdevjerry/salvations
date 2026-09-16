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

  /**
   * Prompt cache effectiveness for a day.
   *
   * The single most useful cost number on an agent platform. A loop re-sends
   * the whole conversation on every step, so at any real length most input
   * tokens SHOULD be cache reads. When this falls, something is perturbing the
   * cacheable prefix — a reordered tool, a timestamp in the system prompt — and
   * the bill roughly triples with nothing else looking wrong.
   */
  async cacheHitRate(day = today()): Promise<CacheHitRate> {
    const rows = await this.#collection.find({ day } as never);

    let cacheRead = 0;
    let fresh = 0;
    for (const row of rows) {
      cacheRead += row.cacheReadTokens ?? 0;
      fresh += row.inputTokens ?? 0;
    }

    const total = cacheRead + fresh;
    return {
      day,
      cacheReadTokens: cacheRead,
      freshInputTokens: fresh,
      // Undefined rather than zero when nothing ran: a rate of 0% and "no data"
      // mean opposite things to whoever is paged by it.
      rate: total === 0 ? undefined : cacheRead / total,
    };
  }
}

export interface CacheHitRate {
  readonly day: string;
  readonly cacheReadTokens: number;
  readonly freshInputTokens: number;
  readonly rate: number | undefined;
}

/**
 * Below this, something is breaking the cacheable prefix.
 *
 * Deliberately not a tight bound: the first turns of any conversation are
 * genuinely uncached, so a low-traffic day sits legitimately below a high one.
 * This is set where a sustained drop is worth investigating rather than where
 * every quiet morning pages someone.
 */
export const CACHE_HIT_RATE_FLOOR = 0.4;

/** Enough tokens for the rate to mean anything. */
export const CACHE_ALERT_MIN_TOKENS = 100_000;

export interface CacheAlert {
  readonly firing: boolean;
  readonly reason?: string;
}

/**
 * Whether a low rate is worth alerting on.
 *
 * Gated on volume, because a rate computed from three thousand tokens is noise
 * and an alert that fires on noise is an alert people learn to close.
 */
export function cacheAlert(measurement: CacheHitRate): CacheAlert {
  const total = measurement.cacheReadTokens + measurement.freshInputTokens;
  if (measurement.rate === undefined || total < CACHE_ALERT_MIN_TOKENS) return { firing: false };
  if (measurement.rate >= CACHE_HIT_RATE_FLOOR) return { firing: false };

  return {
    firing: true,
    reason:
      `Prompt cache hit rate is ${(measurement.rate * 100).toFixed(1)}% on ${measurement.day}, ` +
      `below the ${CACHE_HIT_RATE_FLOOR * 100}% floor. Something is changing the cacheable ` +
      'prefix between steps — check for a reordered tool list or a varying system prompt.',
  };
}

const today = (): string => new Date().toISOString().slice(0, 10);
