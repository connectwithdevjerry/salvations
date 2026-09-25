/**
 * MongoClient lifecycle.
 *
 * On serverless the client is created ONCE PER MODULE INSTANCE and cached on
 * globalThis — never per request. Fluid-style runtimes reuse an instance across
 * concurrent invocations, so a per-request client exhausts the connection pool,
 * and it presents as latency rather than errors (docs/DEPLOYMENT.md D3).
 */
import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';
import {
  defaultGuardMode, handleCommandStarted, type GuardMode, type GuardViolation,
} from './guard';

export interface DbConfig {
  readonly uri: string;
  readonly dbName: string;
  readonly guardMode?: GuardMode;
  readonly maxPoolSize?: number;
  onGuardViolation?(violation: GuardViolation): void;
}

/**
 * Our name for a database handle.
 *
 * Re-exported so nothing above this package has to name the driver's own type.
 * Invariant I4 keeps the driver import in one place; this keeps the TYPE in one
 * place too, so replacing the driver is a change to this alias rather than to
 * every signature that passes a handle along.
 */
export type Database = Db;

export interface DbHandle {
  readonly client: MongoClient;
  readonly db: Db;
  close(): Promise<void>;
}

interface GlobalCache {
  __salvationsDb?: Map<string, Promise<DbHandle>>;
}

const cache = (): Map<string, Promise<DbHandle>> => {
  const g = globalThis as unknown as GlobalCache;
  g.__salvationsDb ??= new Map();
  return g.__salvationsDb;
};

function buildOptions(config: DbConfig): MongoClientOptions {
  return {
    // Required for the tenancy guard: without it the driver emits no
    // commandStarted events and the guard is silently inert.
    monitorCommands: true,
    // Low by design — instances are reused across concurrent invocations.
    maxPoolSize: config.maxPoolSize ?? 10,
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
    serverSelectionTimeoutMS: 10_000,
    retryWrites: true,
    retryReads: true,
    appName: 'salvations',
  };
}

async function connect(config: DbConfig): Promise<DbHandle> {
  const client = new MongoClient(config.uri, buildOptions(config));
  const mode = config.guardMode ?? defaultGuardMode(process.env['NODE_ENV']);

  client.on('commandStarted', (event) => {
    try {
      handleCommandStarted(
        { commandName: event.commandName, command: event.command as Record<string, unknown> },
        {
          mode,
          ...(config.onGuardViolation !== undefined
            ? { onViolation: config.onGuardViolation }
            : {}),
        },
      );
    } catch (error) {
      // A throw inside a monitoring listener would be swallowed by the driver,
      // so surface it on the next tick where it cannot be silently lost.
      queueMicrotask(() => {
        throw error;
      });
    }
  });

  await client.connect();
  return {
    client,
    db: client.db(config.dbName),
    close: () => client.close(),
  };
}

/** Returns the process-wide handle, creating it at most once per configuration. */
export function getDb(config: DbConfig): Promise<DbHandle> {
  const key = `${config.uri}::${config.dbName}::${config.guardMode ?? 'default'}`;
  const map = cache();
  let handle = map.get(key);
  if (handle === undefined) {
    handle = connect(config).catch((error: unknown) => {
      // Never cache a failed connection — the next call must retry.
      map.delete(key);
      throw error;
    });
    map.set(key, handle);
  }
  return handle;
}

export async function closeAllDbs(): Promise<void> {
  const map = cache();
  const handles = [...map.values()];
  map.clear();
  await Promise.all(
    handles.map(async (p) => {
      try {
        await (await p).close();
      } catch {
        // Closing a handle that never connected is not an error worth raising.
      }
    }),
  );
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const uri = env['MONGODB_URI'];
  if (uri === undefined || uri === '') {
    throw new Error('MONGODB_URI is not set');
  }
  return { uri, dbName: env['MONGODB_DB_NAME'] ?? 'salvations' };
}
