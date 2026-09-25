import type { McpCapability } from '@salvations/core';
import type { McpBindingId, McpCapabilityId, WorkspaceId } from '@salvations/core';
import type { McpCapabilityDoc } from '../documents';
import { optional, toDomainId } from '../mappers';

export function capabilityToDomain(doc: McpCapabilityDoc): McpCapability {
  return {
    id: toDomainId<McpCapabilityId>(doc._id),
    workspaceId: toDomainId<WorkspaceId>(doc.workspaceId),
    bindingId: toDomainId<McpBindingId>(doc.bindingId),
    scopeKey: doc.scopeKey,
    kind: doc.kind as McpCapability['kind'],
    name: doc.name,
    canonicalName: doc.canonicalName,
    ...optional('title', doc.title),
    ...optional('description', doc.description),
    ...optional('inputSchema', doc.inputSchema),
    ...optional('outputSchema', doc.outputSchema),
    ...optional('annotations', doc.annotations),
    definitionHash: doc.definitionHash,
    approval: {
      state: doc.approval.state,
      definitionHash: doc.approval.definitionHash,
      ...optional('approvedBy', doc.approval.approvedBy),
      ...optional('approvedAt', doc.approval.approvedAt),
    } as McpCapability['approval'],
    firstSeenAt: doc.firstSeenAt,
    lastSeenAt: doc.lastSeenAt,
    // The field this mapper exists for: a stored null must become undefined, or
    // every live capability reads as removed.
    ...optional('removedAt', doc.removedAt),
  } as McpCapability;
}
