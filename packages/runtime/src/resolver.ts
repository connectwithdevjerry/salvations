/**
 * Resolving a run into something a step can execute.
 *
 * Three things happen here that are easy to get wrong elsewhere:
 *
 * 1. The AGENT SNAPSHOT is read from the run, never re-read from the agent.
 *    A run that changed behaviour halfway because someone edited its prompt is
 *    not reproducible and not debuggable.
 *
 * 2. The PRINCIPAL is re-validated on every resume. A run suspended for two
 *    days must not resume with authority that was revoked yesterday — the
 *    snapshot on the run says who it was, not that they are still allowed.
 *
 * 3. MODEL CAPABILITIES come from the adapter as DATA. Nothing here, and
 *    nothing downstream, asks which vendor it is talking to.
 */
import {
  DomainError,
  type AgentProvider, type ModelCapabilities, type Principal, type ProviderCredentials,
  type ProviderKey, type ProviderRegistry, type ProviderType, type Run, type RunContext,
  type SystemDirective,
} from '@salvations/core';
import { providerKey } from '@salvations/core';
import type { ModelRates } from './budget-meter';
import type { ModelAttempt, ResolvedRun } from './index-types';

export interface ModelBinding {
  readonly id: string;
  readonly providerType: ProviderType;
  readonly modelId: string;
  readonly rates?: ModelRates;
  /** Used only when the primary fails in a way a second model could survive. */
  readonly fallbackBindingId?: string;
  readonly maxOutputTokens?: number;
}

export interface ResolverDeps {
  readonly providers: ProviderRegistry;
  loadModelBinding(bindingId: string): Promise<ModelBinding | undefined>;
  /** Decrypted at use, never held. */
  credentialsFor(binding: ModelBinding): Promise<ProviderCredentials>;
  /** Cached upstream; a cold describeModel is a provider round trip. */
  describeModel(provider: AgentProvider, modelId: string): Promise<ModelCapabilities>;
  /** Returns undefined when the principal no longer holds the authority it did. */
  revalidatePrincipal(principal: Principal): Promise<Principal | undefined>;
  /** Alias → binding id for the MCP bindings this workspace has installed. */
  bindingIdByAlias(workspaceId: string): Promise<ReadonlyMap<string, string>>;
  systemDirectives(run: Run): Promise<readonly SystemDirective[]>;
}

export class PrincipalRevokedError extends DomainError {
  constructor(runId: string) {
    super(
      'forbidden',
      `Run ${runId} cannot continue: the authority it was created with is no longer valid.`,
      // Safe to show: it names no resource the caller could not already see.
      { expose: true, details: { runId } },
    );
    this.name = 'PrincipalRevokedError';
  }
}

export class ModelUnavailableError extends DomainError {
  constructor(bindingId: string, detail: string) {
    super('not_found', detail, { expose: true, details: { bindingId } });
    this.name = 'ModelUnavailableError';
  }
}

export class Resolver {
  readonly #deps: ResolverDeps;

  constructor(deps: ResolverDeps) {
    this.#deps = deps;
  }

  async resolve(run: Run): Promise<ResolvedRun> {
    // Re-validated first: nothing else should be loaded, and no credential
    // decrypted, for a principal that has lost its authority.
    const principal = await this.#deps.revalidatePrincipal(run.principal);
    if (principal === undefined) throw new PrincipalRevokedError(String(run.id));

    const primary = await this.#load(String(run.modelBindingId));
    const fallback = primary.binding.fallbackBindingId !== undefined
      ? await this.#load(primary.binding.fallbackBindingId).catch(() => undefined)
      : undefined;

    const ctx: RunContext = {
      runId: run.id,
      workspaceId: run.workspaceId,
      conversationId: run.conversationId,
      agentId: run.agentId,
      // From the RUN, not the agent: editing an agent must not change a run
      // already in flight.
      agentSnapshot: run.agentSnapshot,
      modelBindingId: run.modelBindingId,
      providerKey: keyOf(primary.binding),
      capabilities: primary.capabilities,
      principal,
      budget: run.budget,
      consumed: run.consumed,
      stepSeq: run.nextStepSeq,
    };

    return {
      ctx,
      attemptsFor: () => {
        const attempts: Omit<ModelAttempt, 'request'>[] = [{
          provider: primary.provider, modelId: primary.binding.modelId, label: 'primary',
        }];
        if (fallback !== undefined) {
          attempts.push({
            provider: fallback.provider, modelId: fallback.binding.modelId, label: 'fallback',
          });
        }
        return attempts;
      },
      ...(primary.binding.rates !== undefined ? { rates: primary.binding.rates } : {}),
      bindingIdByAlias: await this.#deps.bindingIdByAlias(String(run.workspaceId)),
      systemDirectives: await this.#deps.systemDirectives(run),
      maxOutputTokens: Math.min(
        primary.binding.maxOutputTokens ?? primary.capabilities.maxOutputTokens,
        primary.capabilities.maxOutputTokens,
      ),
    };
  }

  async #load(bindingId: string): Promise<{
    binding: ModelBinding; provider: AgentProvider; capabilities: ModelCapabilities;
  }> {
    const binding = await this.#deps.loadModelBinding(bindingId);
    if (binding === undefined) {
      throw new ModelUnavailableError(bindingId, `Model binding ${bindingId} does not exist.`);
    }
    if (!this.#deps.providers.has(binding.providerType)) {
      // A provider type that no longer has an adapter is a deployment problem,
      // and saying so beats a null dereference three layers down.
      throw new ModelUnavailableError(
        bindingId,
        `No adapter is registered for provider type "${String(binding.providerType)}".`,
      );
    }

    const provider = this.#deps.providers.create(
      binding.providerType, await this.#deps.credentialsFor(binding),
    );
    return {
      binding,
      provider,
      capabilities: await this.#deps.describeModel(provider, binding.modelId),
    };
  }
}

/** `provider:model` — the key every stored artifact is filed under. */
export const keyOf = (binding: ModelBinding): ProviderKey =>
  providerKey(String(binding.providerType), binding.modelId);
