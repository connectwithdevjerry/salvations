/**
 * Database handle for the app.
 *
 * getDb caches the client on globalThis, so a warm serverless instance reuses
 * its connection pool instead of opening a new one per request.
 */
import { getDb, type DbHandle } from '@salvations/db';
import { env } from './env';

export function db(): Promise<DbHandle> {
  const e = env();
  return getDb({
    uri: e.MONGODB_URI,
    dbName: e.MONGODB_DB_NAME,
    onGuardViolation: (violation) => {
      // In production the guard reports rather than throws; this is the alert
      // path. A violation here means a query escaped ScopedDb.
      console.error('[tenancy-guard]', JSON.stringify(violation));
    },
  });
}
