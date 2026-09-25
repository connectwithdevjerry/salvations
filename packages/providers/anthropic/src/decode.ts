/**
 * Wire -> canonical translation.
 */
import {
  canonicalNameOf, emptyUsage,
  type ContentBlock, type FinishReason, type ProviderError, type ProviderEvent,
  type ToolNameMap, type Usage,
} from '@salvations/core';

/**
 * Normalises a vendor stop reason.
 *
 * A reason with no canonical equivalent becomes `error` with the raw value
 * preserved. Quietly mapping an unknown terminal state onto `end_turn` is how
 * an agent platform produces confidently truncated answers.
 */
export function mapStopReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'end_turn': return 'end_turn';
    case 'tool_use': return 'tool_use';
    case 'stop_sequence': return 'stop_sequence';
    case 'max_tokens': return 'max_tokens';
    // Output was cut short by the context window rather than by max_tokens, but
    // the consequence for a consumer is identical: the answer is truncated.
    case 'model_context_window_exceeded': return 'max_tokens';
    case 'refusal': return 'refusal';
    // A paused turn expects continuation with server-side tools, which this
    // host does not enable. Treating it as end_turn would silently truncate.
    case 'pause_turn': return 'error';
    default: return raw === null || raw === undefined ? 'end_turn' : 'error';
  }
}

export function mapUsage(raw: unknown): Usage {
  if (raw === null || typeof raw !== 'object') return emptyUsage;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    inputTokens: num(u['input_tokens']),
    outputTokens: num(u['output_tokens']),
    cacheReadTokens: num(u['cache_read_input_tokens']),
    cacheWriteTokens: num(u['cache_creation_input_tokens']),
  };
}

interface BlockState {
  type: string;
  text: string;
  toolId?: string;
  toolName?: string;
  partialJson: string;
  /** Verbatim opaque reasoning, kept for artifact storage. */
  raw?: Record<string, unknown>;
}

/**
 * Folds the vendor's streaming events into canonical ones.
 *
 * Stateful by necessity — content arrives as indexed deltas — so it is written
 * as an explicit accumulator rather than a chain of transforms.
 */
export class StreamDecoder {
  readonly #blocks = new Map<number, BlockState>();
  readonly #toolNames: ToolNameMap;
  readonly #providerKey: string;
  #usage: Usage = emptyUsage;
  #stopReason: string | null = null;
  #messageId = '';

  constructor(toolNames: ToolNameMap, key: string) {
    this.#toolNames = toolNames;
    this.#providerKey = key;
  }

  *handle(event: Record<string, unknown>): Generator<ProviderEvent> {
    const type = event['type'];

    switch (type) {
      case 'message_start': {
        const message = event['message'] as Record<string, unknown> | undefined;
        this.#messageId = String(message?.['id'] ?? '');
        this.#usage = mapUsage(message?.['usage']);
        yield { type: 'start', messageId: this.#messageId };
        return;
      }

      case 'content_block_start': {
        const index = Number(event['index']);
        const block = event['content_block'] as Record<string, unknown>;
        const blockType = String(block['type']);
        const state: BlockState = { type: blockType, text: '', partialJson: '' };

        if (blockType === 'tool_use') {
          state.toolId = String(block['id']);
          state.toolName = canonicalNameOf(this.#toolNames, String(block['name']));
          yield { type: 'tool_use_start', id: state.toolId, name: state.toolName };
        } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          state.raw = { ...block };
        }

        this.#blocks.set(index, state);
        return;
      }

      case 'content_block_delta': {
        const index = Number(event['index']);
        const state = this.#blocks.get(index);
        const delta = event['delta'] as Record<string, unknown>;
        if (state === undefined) return;

        switch (delta['type']) {
          case 'text_delta': {
            const text = String(delta['text'] ?? '');
            state.text += text;
            yield { type: 'text_delta', text };
            return;
          }
          case 'input_json_delta': {
            const partial = String(delta['partial_json'] ?? '');
            state.partialJson += partial;
            if (state.toolId !== undefined) {
              yield { type: 'tool_input_delta', id: state.toolId, partialJson: partial };
            }
            return;
          }
          case 'thinking_delta': {
            const text = String(delta['thinking'] ?? '');
            state.text += text;
            yield { type: 'reasoning_delta', text };
            return;
          }
          case 'signature_delta': {
            // Part of the opaque state; preserved for replay, never rendered.
            if (state.raw !== undefined) state.raw['signature'] = delta['signature'];
            return;
          }
          default:
            return;
        }
      }

      case 'content_block_stop': {
        const state = this.#blocks.get(Number(event['index']));
        if (state?.type === 'tool_use' && state.toolId !== undefined) {
          yield {
            type: 'tool_use_end',
            id: state.toolId,
            input: parseToolInput(state.partialJson),
          };
        }
        if (state?.raw !== undefined) state.raw['thinking'] = state.text;
        return;
      }

      case 'message_delta': {
        const delta = event['delta'] as Record<string, unknown> | undefined;
        this.#stopReason = (delta?.['stop_reason'] as string | null) ?? this.#stopReason;
        const usage = mapUsage(event['usage']);
        // Output tokens arrive here; input tokens came with message_start.
        this.#usage = {
          inputTokens: Math.max(this.#usage.inputTokens, usage.inputTokens),
          outputTokens: Math.max(this.#usage.outputTokens, usage.outputTokens),
          cacheReadTokens: Math.max(this.#usage.cacheReadTokens, usage.cacheReadTokens),
          cacheWriteTokens: Math.max(this.#usage.cacheWriteTokens, usage.cacheWriteTokens),
        };
        yield { type: 'usage', usage: this.#usage };
        return;
      }

      case 'message_stop': {
        yield this.finish();
        return;
      }

      default:
        return;
    }
  }

  finish(): ProviderEvent {
    const content: ContentBlock[] = [];
    const rawReasoning: Record<string, unknown>[] = [];

    for (const state of [...this.#blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s)) {
      if (state.type === 'text' && state.text.length > 0) {
        content.push({ type: 'text', text: state.text });
      } else if (state.type === 'tool_use' && state.toolId !== undefined) {
        content.push({
          type: 'tool_use',
          id: state.toolId,
          name: state.toolName ?? '',
          input: parseToolInput(state.partialJson),
        });
      } else if (state.raw !== undefined) {
        // Canonical side keeps a summary; the opaque original goes to the
        // artifact sidecar, keyed by the model that produced it.
        content.push({
          type: 'reasoning',
          redacted: state.type === 'redacted_thinking',
          ...(state.text.length > 0 ? { summary: state.text } : {}),
        });
        rawReasoning.push(state.raw);
      }
    }

    return {
      type: 'finish',
      reason: mapStopReason(this.#stopReason),
      content,
      usage: this.#usage,
      ...(rawReasoning.length > 0
        ? { providerArtifacts: { [this.#providerKey]: { blocks: rawReasoning } } }
        : {}),
    };
  }
}

/**
 * Tool inputs are always parsed, never string-matched.
 *
 * Escaping of unicode and slashes varies between models, so any structural
 * assumption about the serialised form is unsafe. A truncated stream yields
 * invalid JSON, which surfaces as an empty input the gateway will reject on
 * schema validation rather than as a crash.
 */
function parseToolInput(partialJson: string): unknown {
  if (partialJson.trim() === '') return {};
  try {
    return JSON.parse(partialJson);
  } catch {
    return {};
  }
}

export function mapError(error: unknown): ProviderError {
  const status = (error as { status?: number } | undefined)?.status;
  const name = (error as { name?: string } | undefined)?.name ?? '';
  const message = humanMessage(error);
  const raw = (error as { error?: unknown } | undefined)?.error ?? error;

  const base = { message, providerRaw: raw };

  if (status === 429 || name === 'RateLimitError') {
    const retryAfter = Number(
      (error as { headers?: Record<string, string> } | undefined)?.headers?.['retry-after'],
    );
    return {
      ...base, kind: 'rate_limit', retryable: true,
      ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
    };
  }
  if (status === 401 || status === 403 || name === 'AuthenticationError' || name === 'PermissionDeniedError') {
    return { ...base, kind: 'authentication', retryable: false };
  }
  if (status !== undefined && status >= 500) {
    return { ...base, kind: 'overloaded', retryable: true };
  }
  if (status === 400 || name === 'BadRequestError') {
    const text = message.toLowerCase();
    // A context-length failure is a different remedy from a malformed request:
    // compact and retry, versus fix the request.
    if (text.includes('context') || text.includes('too long') || text.includes('max_tokens')) {
      return { ...base, kind: 'context_length', retryable: false };
    }
    return { ...base, kind: 'invalid_request', retryable: false };
  }
  if (status !== undefined && status >= 400) {
    return { ...base, kind: 'invalid_request', retryable: false };
  }
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
    return { ...base, kind: 'transport', retryable: true };
  }
  return { ...base, kind: 'unknown', retryable: false };
}

/**
 * The vendor's sentence, not the SDK's dump.
 *
 * The SDK's `message` is "<status> <json body>", which is the right thing
 * for a log and the wrong thing for a person. The body carries the sentence
 * the vendor wrote for them; that is what is shown.
 */
export function humanMessage(error: unknown): string {
  const e = error as { message?: string; error?: { message?: string; error?: { message?: string } } } | undefined;
  const nested = e?.error?.error?.message ?? e?.error?.message;
  if (typeof nested === 'string' && nested !== '') return nested;
  const raw = e?.message ?? 'The model provider refused the request.';
  const body = raw.replace(/^\d{3}\s+/, '');
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const fromBody = parsed.error?.message ?? parsed.message;
    if (typeof fromBody === 'string' && fromBody !== '') return fromBody;
  } catch { /* not JSON: the message is already a sentence */ }
  return body;
}
