/**
 * Document ⇄ domain for messages.
 *
 * Written out rather than cast, because the two differ in a way that matters:
 * the document stores `null` for "absent" so the field exists and can be
 * indexed, while the domain uses `undefined` so `?.` and `!== undefined` read
 * correctly. A cast makes `supersededBy: null` satisfy `supersededBy !==
 * undefined`, which quietly turns every live message into a superseded one —
 * the same defect class that once made every capability read as removed.
 */
import {
  asId, type ContentBlock, type ConversationId, type Message, type MessageId,
  type ProviderArtifacts, type RunId,
} from '@salvations/core';
import type { MessageDoc } from '../documents';

export function toMessage(doc: MessageDoc): Message {
  return {
    id: asId<MessageId>(doc._id),
    conversationId: asId<ConversationId>(doc.conversationId),
    seq: doc.seq,
    role: doc.role,
    content: doc.content as readonly ContentBlock[],
    createdAt: doc.createdAt,
    ...(doc.providerArtifacts !== null && doc.providerArtifacts !== undefined
      ? { providerArtifacts: doc.providerArtifacts as ProviderArtifacts }
      : {}),
    ...(doc.runId !== null && doc.runId !== undefined
      ? { runId: asId<RunId>(doc.runId) }
      : {}),
    ...(doc.tokenEstimate !== null && doc.tokenEstimate !== undefined
      ? { tokenEstimate: doc.tokenEstimate }
      : {}),
    ...(doc.supersededBy !== null && doc.supersededBy !== undefined
      ? { supersededBy: asId<MessageId>(doc.supersededBy) }
      : {}),
  };
}
