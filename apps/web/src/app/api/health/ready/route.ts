/**
 * Readiness, which is not liveness.
 *
 * `/api/health` asks "is this process alive and are its dependencies up" — a
 * monitoring question. This asks "should traffic be sent here YET", which is a
 * routing question, and they genuinely differ during a rollout: a process that
 * is alive but whose configuration will not parse should never receive a
 * request, and answering 200 to both is how a broken deployment takes over from
 * a working one.
 *
 * So this checks CONFIGURATION first and cheaply. A deployment missing a secret
 * fails here in milliseconds, before it is ever routed to, rather than failing
 * on the first request that happens to need it.
 */
import { assertSecretsAreDistinct, env } from '@/lib/env';
import { db } from '@/lib/db';
import { ok } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bounded well below any sensible probe timeout — see /api/health. */
const READY_TIMEOUT_MS = 2_000;

const within = <T>(promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), READY_TIMEOUT_MS).unref?.()),
  ]);

export async function GET(): Promise<Response> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // 1. Configuration. Cheap, and the failure a rollout most needs to catch.
  try {
    assertSecretsAreDistinct(env());
    checks['config'] = { ok: true };
  } catch (error) {
    // The message names which variable, never its value — the schema is written
    // that way and this relies on it.
    checks['config'] = {
      ok: false,
      detail: error instanceof Error ? (error.message.split('\n')[0] ?? 'invalid') : 'invalid',
    };
    // Returned immediately: probing a database with no usable configuration
    // adds two seconds and tells nobody anything new.
    return ok({ ready: false, checks }, 503);
  }

  // 2. The database, since every meaningful request needs it.
  try {
    const handle = await within(db());
    await within(handle.db.command({ ping: 1 }));
    checks['database'] = { ok: true };
  } catch (error) {
    checks['database'] = { ok: false, detail: error instanceof Error ? error.name : 'unknown' };
  }

  const ready = Object.values(checks).every((check) => check.ok);
  return ok({ ready, checks }, ready ? 200 : 503);
}
