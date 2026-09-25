/**
 * Document <-> domain mapping.
 *
 * The storage layer uses `null` for absent fields, because BSON distinguishes
 * an explicitly-null field from a missing one and pipeline updates need to
 * write null. The domain uses `undefined`, because that is what TypeScript's
 * optional properties mean.
 *
 * Without this translation the two disagree in ways that are subtle and
 * security-relevant: `removedAt === undefined` is false for a stored `null`, so
 * a live capability would read as removed.
 */
import { asId } from '@salvations/core';
import type { AnyId } from '@salvations/core';

/** BSON null and JS undefined both mean "absent" at the domain boundary. */
export const nullToUndefined = <T>(value: T | null | undefined): T | undefined =>
  value === null ? undefined : value;

export const undefinedToNull = <T>(value: T | undefined): T | null =>
  value === undefined ? null : value;

/** Drops keys whose value is undefined, for use with exactOptionalPropertyTypes. */
export function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** Adds an optional property only when the value is present. */
export const optional = <K extends string, V>(
  key: K,
  value: V | null | undefined,
): Record<K, V> | Record<string, never> =>
  value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);

export const toDomainId = <T extends AnyId>(raw: string): T => asId<T>(raw);
