/**
 * MCP client lifecycle.
 *
 * The 2026-07-28 protocol core is stateless, so a remote server is NOT a
 * long-lived session: there is no handshake to amortise and no session id to
 * pool. What remains worth caching is the SDK client's negotiated era and
 * server capability view, which is per-process and short-lived — exactly right
 * for a serverless invocation.
 */
import { Client, StreamableHTTPClientTransport, type OAuthClientProvider } from '@modelcontextprotocol/client';
import {
  CircuitBreaker, CircuitOpenError, Semaphore, type CircuitState,
} from './resilience';
import { scopeKeyString, type ConnectionScopeKey } from './scope';

/** Advertised to every server we talk to. */
export const CLIENT_INFO = { name: 'salvations', version: '0.1.0' } as const;

/**
 * `in_process` is a first-party server running in this process.
 *
 * It is a TRANSPORT rather than a special case above this layer, and that is
 * the whole point: our own servers reach an agent down the same client, through
 * the same gateway, under the same approval and audit path as a stranger's.
 * The moment they take a shortcut they stop obeying the policy everything else
 * does, and the first thing anybody would build with that shortcut is the thing
 * that most needs the policy.
 */
export type McpTransportKind = 'streamable_http' | 'stdio' | 'in_process';

export interface McpServerDefinition {
  readonly bindingId: string;
  readonly serverId: string;
  readonly alias: string;
  readonly transport: McpTransportKind;
  readonly url?: string;
  /** Pins the protocol era for a server that misbehaves under probing. */
  readonly protocolVersionPin?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Opens a first-party server and returns the client's end of the link.
 *
 * Supplied by the composition root, because the servers know about
 * repositories and this package must not. It returns a transport rather than a
 * server so nothing here needs the server SDK — packages/mcp stays the client
 * side, packages/servers the server side.
 */
export type InProcessOpener = (
  definition: McpServerDefinition,
) => Promise<{ transport: unknown; close(): Promise<void> }>;

export interface ConnectOptions {
  readonly authProvider?: OAuthClientProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxConcurrent?: number;
  /** Required to connect an `in_process` binding, ignored otherwise. */
  readonly openInProcess?: InProcessOpener;
}

export interface ConnectedClient {
  readonly client: Client;
  readonly negotiatedProtocolVersion: string | undefined;
  close(): Promise<void>;
}

export class UnsupportedTransportError extends Error {
  constructor(kind: string) {
    super(
      `Transport "${kind}" is not enabled. Streamable HTTP reaches a remote server and ` +
        'in-process reaches a first-party one; stdio spawns a process with our filesystem ' +
        'and network, and is gated behind sandboxing.',
    );
    this.name = 'UnsupportedTransportError';
  }
}

export async function createClient(
  definition: McpServerDefinition,
  scope: ConnectionScopeKey,
  options: ConnectOptions = {},
): Promise<ConnectedClient> {
  if (definition.transport === 'in_process') {
    return connectInProcess(definition, scope, options);
  }
  if (definition.transport !== 'streamable_http') {
    throw new UnsupportedTransportError(definition.transport);
  }
  if (definition.url === undefined || definition.url === '') {
    throw new Error(`Binding ${definition.bindingId} has no URL.`);
  }

  const client = new Client(CLIENT_INFO, {
    // The SDK keeps its own response cache. Its default partition is shared,
    // which its own documentation calls the safe SINGLE-tenant posture — and
    // this host is multi-tenant. Partitioning by our scope key makes a
    // `private` result unreachable from any other principal.
    cachePartition: scopeKeyString(scope),
    // Probe for the modern era and fall back, rather than assuming either. The
    // result is recorded per binding so operators can see which of their
    // servers are still on the legacy handshake.
    versionNegotiation: {
      mode: definition.protocolVersionPin !== undefined
        ? { pin: definition.protocolVersionPin }
        : 'auto',
    },
  });

  const transport = new StreamableHTTPClientTransport(new URL(definition.url), {
    ...(options.authProvider !== undefined ? { authProvider: options.authProvider } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch as never } : {}),
    ...(definition.headers !== undefined
      ? { requestInit: { headers: { ...definition.headers } } }
      : {}),
  });

  await client.connect(transport);

  return {
    client,
    negotiatedProtocolVersion: client.getNegotiatedProtocolVersion(),
    close: () => client.close(),
  };
}

/**
 * Connects to a server in this process.
 *
 * Still partitioned by the scope key, exactly as a remote connection is. A
 * first-party server is per-agent or per-conversation, so its cached results
 * must not be reachable from another principal's client — and "it's ours"
 * would be precisely the wrong reason to skip that.
 */
async function connectInProcess(
  definition: McpServerDefinition,
  scope: ConnectionScopeKey,
  options: ConnectOptions,
): Promise<ConnectedClient> {
  const opener = options.openInProcess;
  if (opener === undefined) {
    throw new Error(
      `Binding ${definition.bindingId} is an in-process server, but this host was not ` +
      'configured to open one.',
    );
  }

  const client = new Client(CLIENT_INFO, { cachePartition: scopeKeyString(scope) });
  const opened = await opener(definition);

  await client.connect(opened.transport as never);

  return {
    client,
    negotiatedProtocolVersion: client.getNegotiatedProtocolVersion(),
    // Both ends. Closing only the client would leave the server holding
    // whatever its tools closed over — for a per-run server, the run's state.
    close: async () => {
      await client.close().catch(() => undefined);
      await opened.close().catch(() => undefined);
    },
  };
}

export interface BindingHealth {
  readonly circuitState: CircuitState;
  readonly consecutiveFailures: number;
  readonly lastOkAt?: Date;
  readonly lastError?: string;
}

interface Entry {
  readonly connected: ConnectedClient;
  readonly semaphore: Semaphore;
}

/**
 * Owns clients, concurrency and failure state for a process.
 *
 * Concurrency is per BINDING rather than per scope: the limit protects the
 * remote server, and it does not care which of our users is calling.
 */
export class McpClientManager {
  readonly #clients = new Map<string, Entry>();
  readonly #breakers = new Map<string, CircuitBreaker>();
  readonly #health = new Map<string, { lastOkAt?: Date; lastError?: string }>();
  readonly #defaultConcurrency: number;

  constructor(options: { defaultConcurrency?: number } = {}) {
    this.#defaultConcurrency = options.defaultConcurrency ?? 4;
  }

  #breaker(bindingId: string): CircuitBreaker {
    let breaker = this.#breakers.get(bindingId);
    if (breaker === undefined) {
      breaker = new CircuitBreaker();
      this.#breakers.set(bindingId, breaker);
    }
    return breaker;
  }

  async acquire(
    definition: McpServerDefinition,
    scope: ConnectionScopeKey,
    options: ConnectOptions = {},
  ): Promise<Entry> {
    const key = scopeKeyString(scope);
    const existing = this.#clients.get(key);
    if (existing !== undefined) return existing;

    const connected = await createClient(definition, scope, options);
    const entry: Entry = {
      connected,
      semaphore: new Semaphore(options.maxConcurrent ?? this.#defaultConcurrency),
    };
    this.#clients.set(key, entry);
    return entry;
  }

  /**
   * Runs one operation under the binding's concurrency limit and circuit.
   *
   * Every call goes through here, so neither guard can be forgotten at a call
   * site — which is the only way a guard like this stays true.
   */
  async run<T>(
    definition: McpServerDefinition,
    scope: ConnectionScopeKey,
    operation: (client: Client) => Promise<T>,
    options: ConnectOptions = {},
  ): Promise<T> {
    const breaker = this.#breaker(definition.bindingId);
    if (!breaker.tryAcquire()) {
      throw new CircuitOpenError(definition.bindingId, breaker.consecutiveFailures);
    }

    let entry: Entry;
    try {
      entry = await this.acquire(definition, scope, options);
    } catch (error) {
      // Failing to connect is a server failure like any other.
      this.#recordFailure(definition.bindingId, breaker, error);
      throw error;
    }

    const release = await entry.semaphore.acquire();
    try {
      const result = await operation(entry.connected.client);
      breaker.recordSuccess();
      this.#health.set(definition.bindingId, { lastOkAt: new Date() });
      return result;
    } catch (error) {
      this.#recordFailure(definition.bindingId, breaker, error);
      // A failed call may have left the connection unusable; drop it so the
      // next attempt reconnects rather than reusing a broken client.
      await this.evict(scope);
      throw error;
    } finally {
      release();
    }
  }

  #recordFailure(bindingId: string, breaker: CircuitBreaker, error: unknown): void {
    breaker.recordFailure();
    this.#health.set(bindingId, {
      ...this.#health.get(bindingId),
      lastError: error instanceof Error ? error.message : String(error),
    });
  }

  healthOf(bindingId: string): BindingHealth {
    const breaker = this.#breaker(bindingId);
    const health = this.#health.get(bindingId) ?? {};
    return {
      circuitState: breaker.state,
      consecutiveFailures: breaker.consecutiveFailures,
      ...(health.lastOkAt !== undefined ? { lastOkAt: health.lastOkAt } : {}),
      ...(health.lastError !== undefined ? { lastError: health.lastError } : {}),
    };
  }

  async evict(scope: ConnectionScopeKey): Promise<void> {
    const key = scopeKeyString(scope);
    const entry = this.#clients.get(key);
    if (entry === undefined) return;
    this.#clients.delete(key);
    await entry.connected.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(entries.map((e) => e.connected.close().catch(() => undefined)));
  }

  /** Clears failure state after an operator reconfigures a binding. */
  resetBinding(bindingId: string): void {
    this.#breakers.get(bindingId)?.reset();
    this.#health.delete(bindingId);
  }
}
