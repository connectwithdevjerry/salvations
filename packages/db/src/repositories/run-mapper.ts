/**
 * A run document as the domain sees it.
 *
 * `_id` becomes `id`, nulls become absences, strings become branded ids. The
 * executor, the resolver and the runtime all read the domain shape; nothing
 * outside this package should ever see the document.
 */
import type {
  AgentId, AgentVersionId, ConversationId, LeaseToken, ModelBindingId, Principal, ProviderKey,
  Run, RunId, RunStatus, TriggerType, WorkspaceId,
} from '@salvations/core';
import { asId } from '@salvations/core';
import type { RunDoc } from '../documents';

export function toRun(doc: RunDoc): Run {
  return {
    id: asId<RunId>(doc._id),
    workspaceId: asId<WorkspaceId>(doc.workspaceId),
    conversationId: asId<ConversationId>(doc.conversationId),
    agentId: asId<AgentId>(doc.agentId),
    agentVersionId: asId<AgentVersionId>(doc.agentVersionId),
    agentSnapshot: doc.agentSnapshot as unknown as Run['agentSnapshot'],
    modelBindingId: asId<ModelBindingId>(doc.modelBindingId),
    ...(doc.providerKey != null ? { providerKey: doc.providerKey as ProviderKey } : {}),
    trigger: {
      type: doc.trigger.type as TriggerType,
      ...(doc.trigger.ref != null ? { ref: doc.trigger.ref } : {}),
    },
    principal: doc.principal as Principal,
    status: doc.status as RunStatus,
    priority: doc.priority,
    scheduledFor: doc.scheduledFor,
    ...(doc.lease != null
      ? { lease: { owner: doc.lease.owner, until: doc.lease.until, token: doc.lease.token as LeaseToken } }
      : {}),
    attempts: doc.attempts,
    ...(doc.continuation != null
      ? { continuation: { fromStep: doc.continuation.fromStep, reason: doc.continuation.reason as 'deadline' | 'retry' } }
      : {}),
    budget: doc.budget,
    consumed: doc.consumed,
    usage: doc.usage,
    nextStepSeq: doc.nextStepSeq,
    ...(doc.parentRunId != null ? { parentRunId: asId<RunId>(doc.parentRunId) } : {}),
    depth: doc.depth,
    ...(doc.idempotencyKey != null ? { idempotencyKey: doc.idempotencyKey } : {}),
    ...(doc.error != null ? { error: doc.error } : {}),
    queuedAt: doc.queuedAt,
    ...(doc.startedAt != null ? { startedAt: doc.startedAt } : {}),
    ...(doc.finishedAt != null ? { finishedAt: doc.finishedAt } : {}),
    ...(doc.heartbeatAt != null ? { heartbeatAt: doc.heartbeatAt } : {}),
  } as Run;
}
