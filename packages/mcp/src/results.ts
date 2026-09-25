/**
 * Tool result normalisation.
 *
 * Two jobs: translate the protocol's content blocks into our canonical form,
 * and make sure a result cannot blow up a run. A server can return megabytes;
 * feeding that straight into a prompt exhausts the context window, costs real
 * money, and truncates the conversation at the worst possible moment.
 */
import type { BlobStore, ContentBlock } from '@salvations/core';

/** Above this, a single result is spilled to blob storage. */
export const MAX_INLINE_RESULT_BYTES = 64 * 1024;

/** Hard ceiling on what we will even accept from a server before truncating. */
export const MAX_ACCEPTED_RESULT_BYTES = 8 * 1024 * 1024;

export interface NormalisedResult {
  readonly content: readonly ContentBlock[];
  readonly structured?: unknown;
  readonly isError: boolean;
  readonly bytes: number;
  readonly spilledTo?: string;
  readonly truncated: boolean;
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

const sizeOf = (value: unknown): number => {
  try {
    return utf8Bytes(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
};

/**
 * Translates one protocol content block.
 *
 * Binary payloads become blob references rather than inline base64: a
 * base64-encoded image in a prompt is both enormous and useless to a text
 * model, and keeping it inline is how a single screenshot fills a context
 * window.
 */
async function translateBlock(
  block: Record<string, unknown>,
  blobs: BlobStore | undefined,
  keyPrefix: string,
  index: number,
): Promise<ContentBlock> {
  const type = String(block['type'] ?? '');

  if (type === 'text') {
    return { type: 'text', text: String(block['text'] ?? '') };
  }

  if (type === 'image' || type === 'audio') {
    const data = String(block['data'] ?? '');
    const mime = String(block['mimeType'] ?? 'application/octet-stream');
    if (blobs === undefined || data === '') {
      return { type: 'text', text: `[${type} omitted: ${mime}]` };
    }
    const bytes = Buffer.from(data, 'base64');
    const key = `${keyPrefix}/block-${index}`;
    await blobs.put(key, new Uint8Array(bytes), mime);
    return { type: 'blob_ref', key, bytes: bytes.length, mime };
  }

  if (type === 'resource_link') {
    // A link is a pointer, not content. Naming it lets the model ask for it.
    const uri = String(block['uri'] ?? '');
    const name = String(block['name'] ?? uri);
    return { type: 'text', text: `[resource: ${name} <${uri}>]` };
  }

  if (type === 'resource') {
    const resource = block['resource'] as Record<string, unknown> | undefined;
    if (typeof resource?.['text'] === 'string') {
      return { type: 'text', text: resource['text'] };
    }
    const uri = String(resource?.['uri'] ?? '');
    return { type: 'text', text: `[embedded resource <${uri}>]` };
  }

  // An unrecognised block is described rather than dropped: silently losing
  // content the server sent would make a tool look broken for no visible reason.
  return { type: 'text', text: `[unsupported content block: ${type}]` };
}

export interface NormaliseOptions {
  readonly blobs?: BlobStore;
  readonly blobKeyPrefix: string;
  readonly maxInlineBytes?: number;
}

export async function normaliseToolResult(
  raw: unknown,
  options: NormaliseOptions,
): Promise<NormalisedResult> {
  const result = (raw ?? {}) as Record<string, unknown>;
  const isError = result['isError'] === true;
  const rawBlocks = Array.isArray(result['content']) ? (result['content'] as unknown[]) : [];

  const totalBytes = sizeOf(result);
  const maxInline = options.maxInlineBytes ?? MAX_INLINE_RESULT_BYTES;

  // Refuse absurd payloads outright rather than spending memory translating
  // them block by block.
  if (totalBytes > MAX_ACCEPTED_RESULT_BYTES) {
    return {
      content: [{
        type: 'text',
        text:
          `[tool result rejected: ${totalBytes} bytes exceeds the ${MAX_ACCEPTED_RESULT_BYTES}-byte ` +
          'limit. Ask the tool for less, or for a resource reference.]',
      }],
      isError: true,
      bytes: totalBytes,
      truncated: true,
    };
  }

  const content: ContentBlock[] = [];
  for (const [index, block] of rawBlocks.entries()) {
    if (block === null || typeof block !== 'object') continue;
    content.push(
      await translateBlock(block as Record<string, unknown>, options.blobs, options.blobKeyPrefix, index),
    );
  }

  const structured = result['structuredContent'];

  // Oversized-but-acceptable results are spilled whole, so the model sees a
  // reference and the full payload stays retrievable for an operator.
  if (totalBytes > maxInline && options.blobs !== undefined) {
    const key = `${options.blobKeyPrefix}/result.json`;
    await options.blobs.put(
      key,
      new TextEncoder().encode(JSON.stringify(result)),
      'application/json',
    );
    return {
      content: [
        ...summarise(content, maxInline),
        { type: 'text', text: `[result truncated: ${totalBytes} bytes stored at ${key}]` },
      ],
      ...(structured !== undefined ? { structured } : {}),
      isError,
      bytes: totalBytes,
      spilledTo: key,
      truncated: true,
    };
  }

  return {
    content,
    ...(structured !== undefined ? { structured } : {}),
    isError,
    bytes: totalBytes,
    truncated: false,
  };
}

/** Keeps a readable head of the content so the model still has something to work with. */
function summarise(content: readonly ContentBlock[], budgetBytes: number): ContentBlock[] {
  const out: ContentBlock[] = [];
  let used = 0;
  for (const block of content) {
    if (block.type !== 'text') {
      out.push(block);
      continue;
    }
    const remaining = budgetBytes - used;
    if (remaining <= 0) break;
    const text = block.text.length > remaining ? `${block.text.slice(0, remaining)}…` : block.text;
    used += utf8Bytes(text);
    out.push({ type: 'text', text });
  }
  return out;
}

/**
 * Builds the result the MODEL sees when a call is refused.
 *
 * Returned as a tool result with isError, never thrown. An agent that receives
 * nothing simply retries; one told "denied by policy, because X" adapts or
 * explains to the user.
 */
export const refusalResult = (reason: string): NormalisedResult => ({
  content: [{ type: 'text', text: reason }],
  isError: true,
  bytes: utf8Bytes(reason),
  truncated: false,
});
