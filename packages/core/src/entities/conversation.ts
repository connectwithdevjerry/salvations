/**
 * The canonical conversation format.
 *
 * This is a PERSISTENCE format, and persistence formats must be ours. Vendor
 * wire shapes are never the source of truth; adapters translate in and out.
 * That is what lets one conversation continue across different vendors and
 * outlive any single vendor relationship.
 */
import type { ConversationId, MessageId, RunId } from '../ids.js';

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly blobKey: string; readonly mime: string }
  | { readonly type: 'document'; readonly blobKey: string; readonly mime: string; readonly title?: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly content: readonly ContentBlock[];
      readonly structured?: unknown;
      readonly isError: boolean;
    }
  /**
   * A *summary* of reasoning, safe to move between models. The raw reasoning
   * state lives in ProviderArtifacts and is never rendered as text.
   */
  | { readonly type: 'reasoning'; readonly summary?: string; readonly redacted: boolean }
  /** Oversized content spilled to blob storage so a message never nears the document size limit. */
  | { readonly type: 'blob_ref'; readonly key: string; readonly bytes: number; readonly mime: string };

/**
 * Opaque vendor reasoning state, keyed by the exact model that produced it.
 *
 * It is a wire-format payload, not content: never parsed, never rendered, never
 * sent to a browser. The replay rules in `shouldReplayArtifact` are the reason
 * cross-vendor continuation is correct rather than corrupt.
 */
export type ProviderKey = string & { readonly __providerKey: unique symbol };

export const providerKey = (providerType: string, modelId: string): ProviderKey =>
  `${providerType}:${modelId}` as ProviderKey;

export type ProviderArtifacts = Readonly<Record<string, unknown>>;

/**
 * The replay rule, stated once.
 *
 * Same model  -> replay the artifact verbatim and unmodified.
 * Anything else -> drop it; send only canonical `reasoning` summaries.
 *
 * Vendors that require verbatim replay reject or ignore foreign reasoning state,
 * and some enforce an append-only history check that a replayed foreign artifact
 * would violate. Dropping is always safe; replaying across models is not.
 */
export const shouldReplayArtifact = (artifactKey: string, current: ProviderKey): boolean =>
  artifactKey === current;

/**
 * Returns the artifact to replay for `current`, or undefined.
 *
 * Because artifacts are keyed by `provider:model`, a hit is by definition
 * same-model and safe to replay verbatim; a miss means every stored artifact
 * came from a different model and must be dropped.
 */
export const artifactsForModel = (
  artifacts: ProviderArtifacts | undefined,
  current: ProviderKey,
): unknown | undefined => artifacts?.[current];

export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  /** Dense and monotonic within a conversation. History is append-only. */
  readonly seq: number;
  readonly role: MessageRole;
  readonly content: readonly ContentBlock[];
  readonly providerArtifacts?: ProviderArtifacts;
  readonly runId?: RunId;
  readonly tokenEstimate?: number;
  readonly createdAt: Date;
  /** Set when a later message replaces this one. Edits append; they never mutate. */
  readonly supersededBy?: MessageId;
}

/** Message shape accepted by a provider adapter — id/seq assigned on persist. */
export type CanonicalMessage = Pick<Message, 'role' | 'content'> & {
  readonly providerArtifacts?: ProviderArtifacts;
};

export const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

export const toolResultBlock = (
  toolUseId: string,
  content: readonly ContentBlock[],
  options: { structured?: unknown; isError?: boolean } = {},
): ContentBlock => ({
  type: 'tool_result',
  toolUseId,
  content,
  ...(options.structured !== undefined ? { structured: options.structured } : {}),
  isError: options.isError ?? false,
});

/** Flattens a message to plain text, for previews and token estimation. */
export function messageText(content: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool_result') parts.push(messageText(block.content));
    else if (block.type === 'reasoning' && block.summary !== undefined) parts.push(block.summary);
  }
  return parts.join('\n');
}

export const toolUseBlocks = (
  content: readonly ContentBlock[],
): readonly Extract<ContentBlock, { type: 'tool_use' }>[] =>
  content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
