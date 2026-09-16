/**
 * Liveness and readiness.
 *
 * Reports what it actually checked, rather than answering 200 because the
 * process is running. A health check that cannot fail is a health check that
 * tells you nothing.
 */
import { db } from '@/lib/db';
import { eventBus } from '@/lib/container';
import { ok } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Check { ok: boolean; detail?: string; latencyMs?: number }

/**
 * How long any single check may take.
 *
 * Shorter than the driver's own server-selection timeout on purpose. Left to
 * the driver, an unreachable database makes this endpoint answer in ten
 * seconds — by which time a load balancer has given up and recorded a TIMEOUT
 * rather than the `degraded` this endpoint exists to report. A health check
 * that is slower than the thing probing it tells nobody anything.
 */
const CHECK_TIMEOUT_MS = 2_000;

class CheckTimeout extends Error {
  constructor() {
    super('timed out');
    this.name = 'CheckTimeout';
  }
}

const within = <T>(promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new CheckTimeout()), CHECK_TIMEOUT_MS).unref?.()),
  ]);

export async function GET(): Promise<Response> {
  const checks: Record<string, Check> = {};

  const started = Date.now();
  try {
    const handle = await within(db());
    await within(handle.db.command({ ping: 1 }));
    checks['database'] = { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    checks['database'] = {
      ok: false,
      latencyMs: Date.now() - started,
      // The name, not the message: a driver message can carry a host list, and
      // this endpoint is usually reachable without authentication.
      detail: error instanceof Error ? error.name : 'unknown',
    };
  }

  try {
    const { kind } = await within(eventBus());
    // Not a failure — polling works — but an operator should be able to see it
    // rather than infer a latency regression from graphs.
    checks['eventStream'] = { ok: true, detail: kind };
  } catch {
    checks['eventStream'] = { ok: false };
  }

  const healthy = Object.values(checks).every((c) => c.ok);
  return ok(
    { status: healthy ? 'ok' : 'degraded', checks },
    // 503 when degraded, so a load balancer can act on it without parsing JSON.
    healthy ? 200 : 503,
  );
}
