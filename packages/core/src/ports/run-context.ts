import type { AgentId, ConversationId, ModelBindingId, RunId, WorkspaceId } from '../ids.js';
import type { AgentSnapshot, RunBudget, RunConsumption } from '../entities/run.js';
import type { Principal } from '../entities/principal.js';
import type { ModelCapabilities, ProviderKey } from './index-types.js';

/** Immutable frame resolved once per run and read by every phase. */
export interface RunContext {
  readonly runId: RunId;
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly agentId: AgentId;
  readonly agentSnapshot: AgentSnapshot;
  readonly modelBindingId: ModelBindingId;
  readonly providerKey: ProviderKey;
  readonly capabilities: ModelCapabilities;
  readonly principal: Principal;
  readonly budget: RunBudget;
  readonly consumed: RunConsumption;
  readonly stepSeq: number;
}
