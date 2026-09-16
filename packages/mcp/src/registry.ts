/**
 * Binding resolution.
 *
 * A workspace installs a server as a BINDING; agents attach to bindings, never
 * to servers. This module turns a binding into the concrete things a call
 * needs — a transport definition, a connection scope, an MRTR policy — and is
 * the single place where "may we even talk to this server" is decided.
 *
 * It holds no data access of its own. Records arrive through a narrow port, so
 * the protocol layer stays free of the database and this stays testable without
 * one.
 */
import { MAX_TOOL_TIMEOUT_MS, type McpAuthMode, type TrustTier } from '@salvations/core';
import type { McpServerDefinition, McpTransportKind } from './client';
import { DEFAULT_MRTR_POLICY, type MrtrPolicy } from './mrtr';
import { DEFAULT_TOOL_TIMEOUT_MS } from '@salvations/core';
import { scopeFor, type ConnectionScopeKey } from './scope';

export type BindingStatus = 'pending_auth' | 'connected' | 'error' | 'disabled';

export interface BindingRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly mcpServerId: string;
  readonly alias: string;
  readonly enabled: boolean;
  readonly status: BindingStatus;
  readonly perUserAuth: boolean;
  readonly credentialId?: string;
  /** Per-binding overrides. Anything absent falls back to the restrictive default. */
  readonly mrtr?: Partial<MrtrPolicy>;
  readonly timeoutMs?: number;
}

export interface ServerRecord {
  readonly id: string;
  readonly slug: string;
  readonly transport: McpTransportKind;
  readonly url?: string;
  readonly authMode: McpAuthMode;
  readonly trustTier: TrustTier;
  readonly protocolVersionPin?: string;
}

export interface BindingSource {
  load(workspaceId: string, bindingId: string):
    Promise<{ binding: BindingRecord; server: ServerRecord } | undefined>;
  listEnabled(workspaceId: string): Promise<{ binding: BindingRecord; server: ServerRecord }[]>;
}

/**
 * Supplies whatever the transport needs to authenticate, for one scope.
 *
 * Returns fresh material each time and nothing is cached here: a resolved
 * definition can carry a bearer token, and a cached definition is a token with
 * an unbounded lifetime attached to a key someone else may reach.
 */
export interface ConnectionAuthSource {
  headersFor(
    binding: BindingRecord, server: ServerRecord, scope: ConnectionScopeKey,
  ): Promise<Readonly<Record<string, string>> | undefined>;
}

export interface ResolvedBinding {
  readonly definition: McpServerDefinition;
  readonly scope: ConnectionScopeKey;
  readonly mrtrPolicy: MrtrPolicy;
  readonly timeoutMs: number;
  readonly trustTier: TrustTier;
}

export class BindingUnavailableError extends Error {
  readonly bindingId: string;
  readonly reason: 'not_found' | 'disabled' | 'pending_auth' | 'errored' | 'unsupported_transport'
    | 'no_url';

  constructor(bindingId: string, reason: BindingUnavailableError['reason'], detail: string) {
    super(detail);
    this.name = 'BindingUnavailableError';
    this.bindingId = bindingId;
    this.reason = reason;
  }
}

/**
 * The inference ceiling a trust tier imposes.
 *
 * A binding's own configuration can only ever be more restrictive than this.
 * Letting an unvetted server spend the workspace's model budget on prompts it
 * writes is the one MRTR power that cannot be undone after the fact, so it is
 * not something a single admin toggle should be able to hand to an anonymous
 * publisher.
 */
const MAY_REQUEST_INFERENCE: Readonly<Record<TrustTier, boolean>> = Object.freeze({
  first_party: true,
  verified: true,
  community: false,
  untrusted: false,
});

export function effectiveMrtrPolicy(
  binding: BindingRecord,
  server: ServerRecord,
): MrtrPolicy {
  const configured = { ...DEFAULT_MRTR_POLICY, ...binding.mrtr };
  return {
    // Trust tier is a ceiling, not a default: configuration cannot raise it.
    allowInference: configured.allowInference && MAY_REQUEST_INFERENCE[server.trustTier],
    allowHumanInput: configured.allowHumanInput,
    maxRounds: Math.max(0, Math.min(configured.maxRounds, DEFAULT_MRTR_POLICY.maxRounds * 4)),
  };
}

export class McpServerRegistry {
  readonly #source: BindingSource;
  readonly #auth: ConnectionAuthSource | undefined;

  constructor(source: BindingSource, auth?: ConnectionAuthSource) {
    this.#source = source;
    this.#auth = auth;
  }

  /**
   * Resolves one binding for one caller.
   *
   * `userId` is required for a per-user binding — `scopeFor` throws rather than
   * quietly falling back to a workspace scope, which would let one person act
   * with another's tokens.
   */
  async resolve(
    workspaceId: string,
    bindingId: string,
    userId?: string,
  ): Promise<ResolvedBinding> {
    const record = await this.#source.load(workspaceId, bindingId);
    if (record === undefined) {
      throw new BindingUnavailableError(
        bindingId, 'not_found', `No binding ${bindingId} in this workspace.`,
      );
    }

    const { binding, server } = record;
    assertUsable(binding, server);

    const scope = scopeFor(workspaceId, binding.id, binding.perUserAuth, userId);
    const headers = await this.#auth?.headersFor(binding, server, scope);

    return {
      definition: {
        bindingId: binding.id,
        serverId: server.id,
        alias: binding.alias,
        transport: server.transport,
        ...(server.url !== undefined ? { url: server.url } : {}),
        ...(server.protocolVersionPin !== undefined
          ? { protocolVersionPin: server.protocolVersionPin }
          : {}),
        ...(headers !== undefined ? { headers } : {}),
      },
      scope,
      mrtrPolicy: effectiveMrtrPolicy(binding, server),
      timeoutMs: Math.min(binding.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS),
      trustTier: server.trustTier,
    };
  }

  /**
   * Every binding a workspace can currently call.
   *
   * One that cannot be used is SKIPPED rather than thrown on: listing is how a
   * run assembles its tool surface, and a single server awaiting consent must
   * not take the whole surface down with it.
   */
  async listUsable(workspaceId: string, userId?: string): Promise<ResolvedBinding[]> {
    const records = await this.#source.listEnabled(workspaceId);
    const resolved: ResolvedBinding[] = [];

    for (const { binding } of records) {
      try {
        resolved.push(await this.resolve(workspaceId, binding.id, userId));
      } catch (error) {
        if (error instanceof BindingUnavailableError) continue;
        // A per-user binding with no user is a programming error in the caller,
        // not a server problem, and silently dropping it would hide the bug.
        throw error;
      }
    }

    return resolved;
  }
}

function assertUsable(binding: BindingRecord, server: ServerRecord): void {
  if (!binding.enabled || binding.status === 'disabled') {
    throw new BindingUnavailableError(
      binding.id, 'disabled', `The ${binding.alias} server is disabled for this workspace.`,
    );
  }
  if (binding.status === 'pending_auth') {
    throw new BindingUnavailableError(
      binding.id, 'pending_auth',
      `The ${binding.alias} server has not been authorised yet. An administrator must complete ` +
        'its connection.',
    );
  }
  if (binding.status === 'error') {
    throw new BindingUnavailableError(
      binding.id, 'errored', `The ${binding.alias} server is in an error state.`,
    );
  }
  if (server.transport !== 'streamable_http') {
    // stdio spawns a process with our filesystem and network. It is gated
    // behind sandboxing, not behind a configuration flag.
    throw new BindingUnavailableError(
      binding.id, 'unsupported_transport',
      `Transport "${server.transport}" is not enabled in this deployment.`,
    );
  }
  if (server.url === undefined || server.url === '') {
    throw new BindingUnavailableError(
      binding.id, 'no_url', `The ${binding.alias} server has no URL configured.`,
    );
  }
}
