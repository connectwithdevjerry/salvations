/**
 * Worker service entrypoint — PLACEHOLDER (Phase 4).
 *
 * This exists in Phase 1 deliberately. It is compiled and smoke-tested on every
 * commit so that "moving background execution to a separate service is a
 * configuration change" stays a tested claim rather than an assumption.
 *
 * When Phase 4 arrives this file changes only at the composition root: bind
 * ContinuousExecutor instead of SlicedExecutor, and optionally a Redis-backed
 * RunQueue. Nothing in @salvations/core, /runtime or /mcp moves.
 */
import { DEFAULT_BUDGET, type RunBudget } from '@salvations/core';

interface WorkerConfig {
  readonly mongoUri: string;
  readonly dbName: string;
  readonly leaseMs: number;
  readonly concurrency: number;
  readonly budget: RunBudget;
}

function loadConfig(): WorkerConfig {
  const mongoUri = process.env['MONGODB_URI'];
  if (mongoUri === undefined || mongoUri === '') {
    throw new Error('MONGODB_URI is required');
  }
  return {
    mongoUri,
    dbName: process.env['MONGODB_DB_NAME'] ?? 'salvations',
    leaseMs: Number(process.env['WORKER_LEASE_MS'] ?? 60_000),
    concurrency: Number(process.env['WORKER_CONCURRENCY'] ?? 4),
    // A long-lived worker has no slice deadline, so it gets the full wall clock.
    budget: { ...DEFAULT_BUDGET, maxWallClockMs: 2 * 60 * 60 * 1000 },
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--smoke')) {
    // CI smoke test: prove the worker's dependency graph compiles, loads and
    // boots without requiring a database.
    process.stdout.write('worker: smoke ok\n');
    return;
  }

  const config = loadConfig();
  process.stdout.write(
    `worker: configured db=${config.dbName} concurrency=${config.concurrency}\n`,
  );
  // Phase 4: claim loop over RunQueue + ContinuousExecutor.
  throw new Error('Worker execution loop is Phase 4. Run with --smoke in CI.');
}

main().catch((error: unknown) => {
  process.stderr.write(`worker: ${String(error)}\n`);
  process.exitCode = 1;
});
