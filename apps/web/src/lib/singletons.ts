/**
 * Things that must exist once per process.
 *
 * Extracted from the container because the container COMPOSES — it builds a
 * session out of repositories, servers and a gateway — and the pieces it
 * composes need these too. Leaving them in the container made every service
 * that wanted a provider registry import the module that imports it, which is
 * a cycle: dependency-cruiser caught two.
 *
 * Cached on globalThis rather than in a module variable, because a serverless
 * runtime may evaluate a module more than once within one process and a second
 * circuit breaker is not a circuit breaker.
 */
import { McpClientManager } from '@salvations/mcp';
import { createRegistry } from '@salvations/provider-registry';
import { createEventBus, type RunEventReader } from '@salvations/db';
import { InMemoryMetrics } from '@salvations/observability';
import { db } from './db';

interface Singletons {
  providers?: ReturnType<typeof createRegistry>;
  mcpManager?: McpClientManager;
  metrics?: InMemoryMetrics;
  eventBus?: Promise<{ bus: RunEventReader; kind: string }>;
}

const store = globalThis as typeof globalThis & { __salvations__?: Singletons };
const singletons = (): Singletons => (store.__salvations__ ??= {});

/** Adapters for every provider type this build knows about. */
export const providers = () => (singletons().providers ??= createRegistry());

/**
 * Connections, concurrency limits and circuit state for MCP servers.
 *
 * Process-wide rather than per-request: a breaker that resets on every request
 * is not a breaker, and the whole point is to stop hammering a failing server.
 */
export const mcpManager = () => (singletons().mcpManager ??= new McpClientManager());

export const metrics = () => (singletons().metrics ??= new InMemoryMetrics());

/** Probed once per process — see `createEventBus`. */
export async function eventBus(): Promise<{ bus: RunEventReader; kind: string }> {
  const handle = await db();
  return (singletons().eventBus ??= createEventBus(handle.db));
}

export { keyProvider } from './keys';
