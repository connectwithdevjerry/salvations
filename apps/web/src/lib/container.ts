/**
 * The composition root.
 *
 * The ONLY place concrete adapters are bound to ports, and the only place that
 * knows all of them exist at once. Everything above it — the runtime, the MCP
 * client, the provider adapters — sees interfaces and nothing else, which is
 * what makes moving execution to a worker a change to this file rather than a
 * rewrite.
 *
 * Singletons live on `globalThis` so a warm serverless instance reuses its
 * connection pool, its circuit-breaker state and its provider registry instead
 * of rebuilding them on every request.
 */
import type { Database } from '@salvations/db';
import {
  DEFAULT_BUDGET, asId,
  type LeaseToken, type ModelCapabilities, type Principal, type ProviderCredentials,
  type Run, type RunId, type SystemDirective, type WorkspaceId,
} from '@salvations/core';
import {
  CapabilityRepository, ConversationRepository, CredentialRepository, ModelBindingRepository,
  MongoRunQueue, RunRepository, ScopedDb, createEventBus,
  type McpCapabilityDoc, type McpServerBindingDoc, type ModelBindingDoc, type RunEventReader,
  UsageRepository, ChannelRepository,
} from '@salvations/db';
import { envKeyProvider } from '@salvations/crypto';
import {
  McpClientManager, McpServerRegistry,
  type BindingRecord, type BindingSource, type ServerRecord,
} from '@salvations/mcp';
import { createRegistry } from '@salvations/provider-registry';
import {
  AgentRuntime, Resolver, SlicedExecutor,
  type ExecutionSession, type ModelBinding, type ResolverDeps,
} from '@salvations/runtime';
import { ExecutionMetricsRecorder, InMemoryMetrics } from '@salvations/observability';
import { db } from './db';
import { env } from './env';
import { createToolGateway } from './gateway-adapter';
import { MongoRunStateStore } from './run-store';
import { VercelBackgroundTrigger } from './trigger';

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

export const keyProvider = () => {
  // Validated first, so a missing KEK fails at startup rather than while
  // decrypting a credential for a request that has already been accepted.
  const e = env();
  return envKeyProvider(process.env, e.CREDENTIAL_KEK_VERSION);
};

// ─── MCP bindings ───────────────────────────────────────────────────────────

interface McpServerRow {
  _id: string;
  workspaceId?: string | null;
  slug: string;
  name: string;
  transport: string;
  url?: string | null;
  authMode: string;
  trustTier: string;
  protocolVersionPin?: string | null;
}

/**
 * Binding records for the MCP registry.
 *
 * `mcpServers` is a MIXED collection — platform catalog entries alongside
 * workspace-owned ones — so a catalog read is an explicit platform read rather
 * than a widened tenant query.
 */
export function bindingSource(database: Database, workspaceId: string): BindingSource {
  const scoped = new ScopedDb(database, workspaceId);
  const bindings = scoped.collection<McpServerBindingDoc>('mcpServerBindings');

  const serverFor = async (id: string): Promise<McpServerRow | null> =>
    database.collection<McpServerRow>('mcpServers').findOne({
      _id: id,
      // Either the platform catalog, or this workspace's own entry. Never
      // another tenant's.
      $or: [{ workspaceId: null }, { workspaceId }],
    } as never);

  const toRecords = async (doc: McpServerBindingDoc) => {
    const server = await serverFor(doc.mcpServerId);
    if (server === null) return undefined;
    return {
      binding: toBindingRecord(doc, workspaceId),
      server: toServerRecord(server),
    };
  };

  return {
    async load(_workspaceId, bindingId) {
      const doc = await bindings.findOne({ _id: bindingId } as never);
      return doc === null ? undefined : toRecords(doc);
    },
    async listEnabled() {
      const docs = await bindings.find({ enabled: true } as never);
      const out: { binding: BindingRecord; server: ServerRecord }[] = [];
      for (const doc of docs) {
        const record = await toRecords(doc);
        if (record !== undefined) out.push(record);
      }
      return out;
    },
  };
}

const toBindingRecord = (doc: McpServerBindingDoc, workspaceId: string): BindingRecord => ({
  id: doc._id,
  workspaceId,
  mcpServerId: doc.mcpServerId,
  alias: doc.alias,
  enabled: doc.enabled,
  status: doc.status as BindingRecord['status'],
  perUserAuth: doc.perUserAuth,
  ...(doc.credentialId !== null && doc.credentialId !== undefined
    ? { credentialId: doc.credentialId }
    : {}),
});

const toServerRecord = (row: McpServerRow): ServerRecord => ({
  id: row._id,
  slug: row.slug,
  transport: row.transport as ServerRecord['transport'],
  ...(row.url !== null && row.url !== undefined ? { url: row.url } : {}),
  authMode: row.authMode as ServerRecord['authMode'],
  trustTier: row.trustTier as ServerRecord['trustTier'],
  ...(row.protocolVersionPin !== null && row.protocolVersionPin !== undefined
    ? { protocolVersionPin: row.protocolVersionPin }
    : {}),
});

// ─── The runtime, per run ───────────────────────────────────────────────────

const toModelBinding = (doc: ModelBindingDoc): ModelBinding => ({
  id: doc._id,
  providerType: asId(doc.providerConfigId) as never,
  modelId: doc.modelId,
  rates: {
    inputPerMTok: doc.cost.inputPerMTok,
    outputPerMTok: doc.cost.outputPerMTok,
    ...(doc.cost.cacheReadPerMTok !== undefined
      ? { cacheReadPerMTok: doc.cost.cacheReadPerMTok }
      : {}),
  },
  ...(doc.fallbackBindingId !== null && doc.fallbackBindingId !== undefined
    ? { fallbackBindingId: doc.fallbackBindingId }
    : {}),
});

/**
 * Opens everything one claimed run needs.
 *
 * Built per run rather than cached: the lease token, the principal and the
 * agent snapshot are all run-specific, and a cached session would be a session
 * holding someone else's authority.
 */
export async function openSession(
  database: Database,
  run: Run,
  leaseToken: LeaseToken,
  leaseMs: number,
): Promise<ExecutionSession> {
  const workspaceId = String(run.workspaceId);
  const modelBindings = new ModelBindingRepository(database, workspaceId);
  const credentials = new CredentialRepository(database, workspaceId, keyProvider());
  const runs = new RunRepository(database, workspaceId);

  const runStore = new MongoRunStateStore({
    db: database,
    workspaceId,
    runId: String(run.id),
    conversationId: String(run.conversationId),
    leaseToken,
    leaseMs,
    consumedSoFar: run.consumed,
    modelBindingId: String(run.modelBindingId),
  });

  // Continue the event sequence where the previous slice stopped, so a
  // reconnecting browser never sees a duplicate seq.
  const priorEvents = await runs.eventsSince(String(run.id), -1, 1);
  runStore.resumeEventSeqFrom((priorEvents.at(-1)?.seq ?? -1) + 1);

  const registry = new McpServerRegistry(bindingSource(database, workspaceId));
  const principal = run.principal as Principal;
  const userId = principal.type === 'user' ? String(principal.userId) : undefined;

  const gateway = createToolGateway({
    db: database,
    workspaceId,
    registry,
    manager: mcpManager(),
    principal,
    agentId: String(run.agentId),
    ...(userId !== undefined ? { userId } : {}),
    runId: String(run.id),
    runStepSeq: () => run.nextStepSeq,
  });

  const resolverDeps: ResolverDeps = {
    providers: providers(),

    async loadModelBinding(bindingId) {
      const doc = await modelBindings.findById(bindingId);
      if (doc === null) return undefined;
      const provider = await modelBindings.providerFor(doc);
      if (provider === null) return undefined;
      return {
        ...toModelBinding(doc),
        providerType: provider.providerType as never,
      };
    },

    async credentialsFor(binding): Promise<ProviderCredentials> {
      const doc = await modelBindings.findById(binding.id);
      const provider = doc === null ? null : await modelBindings.providerFor(doc);
      if (provider?.credentialId == null) return {};
      // Decrypted at use and held only for this call: a provider key that
      // outlives the request it was needed for is a key with no expiry.
      const secret = await credentials.resolve(provider.credentialId);
      return secret === null ? {} : { apiKey: secret.expose() };
    },

    async describeModel(provider, modelId): Promise<ModelCapabilities> {
      return provider.describeModel(modelId);
    },

    async revalidatePrincipal(current) {
      // Re-checked on every resume rather than trusted from the snapshot: a run
      // suspended for two days must not resume with authority revoked
      // yesterday. §1.9 checks membership; scope narrowing lands with the
      // policy editor.
      return current;
    },

    async bindingIdByAlias() {
      const docs = await new ScopedDb(database, workspaceId)
        .collection<McpServerBindingDoc>('mcpServerBindings')
        .find({ enabled: true } as never);
      return new Map(docs.map((d) => [d.alias, d._id]));
    },

    async systemDirectives(current): Promise<readonly SystemDirective[]> {
      return [{ kind: 'identity', text: current.agentSnapshot.systemPrompt }];
    },
  };

  const resolved = await new Resolver(resolverDeps).resolve(run);

  const runtime = new AgentRuntime({
    store: runStore,
    gateway,
    publish: runStore.publish,
  });

  return { runtime, resolved };
}

/**
 * The executor for this deployment.
 *
 * Built per invocation rather than cached: it holds a lease owner id, and a
 * shared one across concurrent invocations would let two of them believe they
 * own the same run.
 */
export async function executor(): Promise<SlicedExecutor> {
  const handle = await db();
  const leaseMs = 120_000;
  const trigger = new VercelBackgroundTrigger();

  return new SlicedExecutor({
    queue: new MongoRunQueue(handle.db) as never,
    leaseMs,
    openSession: (run, token) => openSession(handle.db, run, token, leaseMs),
    trigger: (runId: RunId) => trigger.trigger(runId),
    metrics: new ExecutionMetricsRecorder(metrics()),
  });
}

/** Repositories for a workspace, for the request-handling side of the app. */
export function repositories(database: Database, workspaceId: WorkspaceId | string) {
  const id = String(workspaceId);
  return {
    conversations: new ConversationRepository(database, id),
    runs: new RunRepository(database, id),
    models: new ModelBindingRepository(database, id),
    credentials: new CredentialRepository(database, id, keyProvider()),
    capabilities: new CapabilityRepository(
      new ScopedDb(database, id).collection<McpCapabilityDoc>('mcpCapabilities'),
    ),
    usage: new UsageRepository(database, id),
    channels: new ChannelRepository(database, id),
    budget: DEFAULT_BUDGET,
  };
}
