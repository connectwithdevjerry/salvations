/**
 * Wire translation for this vendor.
 *
 * A different shape from every other adapter — flat messages, string-encoded
 * tool arguments, a terminal sentinel instead of a stop event — which is
 * exactly why this lives behind the port.
 */
import {
  buildToolNameMap, canonicalNameOf, emptyUsage, wireNameOf,
  type CanonicalMessage, type ContentBlock, type FinishReason, type GenerationRequest,
  type ModelCapabilities, type ProviderError, type ProviderEvent, type ToolNameMap,
  type Usage,
} from '@salvations/core';

export interface EncodedRequest {
  readonly body: Record<string, unknown>;
  readonly toolNames: ToolNameMap;
}

const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');

/**
 * Flattens a canonical turn.
 *
 * Tool results are separate messages here rather than blocks inside a user
 * turn, so one canonical message can expand into several.
 */
function encodeMessage(message: CanonicalMessage, tools: ToolNameMap): Record<string, unknown>[] {
  const toolResults = message.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
  );
  if (toolResults.length > 0) {
    return toolResults.map((result) => ({
      role: 'tool',
      tool_call_id: result.toolUseId,
      content: textOf(result.content),
    }));
  }

  const toolCalls = message.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );

  const encoded: Record<string, unknown> = {
    role: message.role === 'tool' ? 'user' : message.role,
    content: textOf(message.content),
  };

  if (toolCalls.length > 0) {
    encoded['tool_calls'] = toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: wireNameOf(tools, call.name),
        // Arguments travel as a JSON STRING here, not an object.
        arguments: JSON.stringify(call.input ?? {}),
      },
    }));
  }

  // Reasoning is not carried on this transport; the canonical summary stays in
  // our store and is simply not sent.
  return [encoded];
}

export function encodeRequest(
  request: GenerationRequest,
  modelId: string,
  capabilities: ModelCapabilities,
): EncodedRequest {
  const toolNames = buildToolNameMap(
    request.tools.map((t) => t.name),
    { namePattern: capabilities.tools.namePattern, maxNameLength: capabilities.tools.maxNameLength },
  );

  const messages: Record<string, unknown>[] = [];
  if (request.system.length > 0) {
    messages.push({ role: 'system', content: request.system.map((d) => d.text).join('\n\n') });
  }
  for (const message of request.messages) {
    messages.push(...encodeMessage(message, toolNames));
  }

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    max_completion_tokens: Math.min(request.maxOutputTokens, capabilities.maxOutputTokens),
    stream: true,
    // Without this the final chunk carries no usage, and a run that cannot
    // account for its spend cannot enforce a budget.
    stream_options: { include_usage: true },
  };

  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: wireNameOf(toolNames, tool.name),
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    body['tool_choice'] =
      request.toolChoice === 'none' ? 'none'
      : typeof request.toolChoice === 'object' && capabilities.tools.forcedChoice
        ? { type: 'function', function: { name: wireNameOf(toolNames, request.toolChoice.name) } }
        : 'auto';
  }

  if (request.reasoning?.effort !== undefined && capabilities.reasoning.supported) {
    body['reasoning_effort'] = request.reasoning.effort === 'xhigh' || request.reasoning.effort === 'max'
      ? 'high'   // This vendor's scale stops at high; clamp rather than 400.
      : request.reasoning.effort;
  }

  if (request.structuredOutput !== undefined) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: 'output', schema: request.structuredOutput.schema, strict: true },
    };
  }

  if (request.stopSequences !== undefined && request.stopSequences.length > 0) {
    body['stop'] = [...request.stopSequences];
  }

  return { body, toolNames };
}

export function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'content_filter';
    // A legacy function-call stop behaves like a tool call for a consumer.
    case 'function_call': return 'tool_use';
    default: return raw === null || raw === undefined ? 'end_turn' : 'error';
  }
}

function mapUsage(raw: unknown): Usage {
  if (raw === null || typeof raw !== 'object') return emptyUsage;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const details = u['prompt_tokens_details'] as Record<string, unknown> | undefined;
  const cached = num(details?.['cached_tokens']);
  return {
    // Cached tokens are reported INSIDE the prompt total here, so counting both
    // would double-bill the run.
    inputTokens: Math.max(0, num(u['prompt_tokens']) - cached),
    outputTokens: num(u['completion_tokens']),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

interface ToolState { id: string; name: string; arguments: string }

/** Folds this vendor's chunk format into canonical events. */
export class StreamDecoder {
  readonly #tools = new Map<number, ToolState>();
  readonly #toolNames: ToolNameMap;
  #text = '';
  #usage: Usage = emptyUsage;
  #finish: string | null = null;
  #started = false;
  #endedTools = new Set<number>();

  constructor(toolNames: ToolNameMap) {
    this.#toolNames = toolNames;
  }

  *handle(chunk: Record<string, unknown>): Generator<ProviderEvent> {
    if (!this.#started) {
      this.#started = true;
      yield { type: 'start', messageId: String(chunk['id'] ?? '') };
    }

    const usage = chunk['usage'];
    if (usage !== null && usage !== undefined) this.#usage = mapUsage(usage);

    const choice = (chunk['choices'] as Record<string, unknown>[] | undefined)?.[0];
    if (choice === undefined) return;

    const finish = choice['finish_reason'];
    if (typeof finish === 'string') this.#finish = finish;

    const delta = choice['delta'] as Record<string, unknown> | undefined;
    if (delta === undefined) return;

    const content = delta['content'];
    if (typeof content === 'string' && content.length > 0) {
      this.#text += content;
      yield { type: 'text_delta', text: content };
    }

    const toolCalls = delta['tool_calls'] as Record<string, unknown>[] | undefined;
    for (const call of toolCalls ?? []) {
      const index = Number(call['index'] ?? 0);
      const fn = call['function'] as Record<string, unknown> | undefined;
      let state = this.#tools.get(index);

      if (state === undefined) {
        state = {
          id: String(call['id'] ?? `call_${index}`),
          name: canonicalNameOf(this.#toolNames, String(fn?.['name'] ?? '')),
          arguments: '',
        };
        this.#tools.set(index, state);
        yield { type: 'tool_use_start', id: state.id, name: state.name };
      }

      const args = fn?.['arguments'];
      if (typeof args === 'string' && args.length > 0) {
        state.arguments += args;
        yield { type: 'tool_input_delta', id: state.id, partialJson: args };
      }
    }

    // There is no per-block stop event, so completion is inferred from the
    // finish reason: every accumulated call is done at that point.
    if (this.#finish !== null) {
      for (const [index, state] of this.#tools) {
        if (this.#endedTools.has(index)) continue;
        this.#endedTools.add(index);
        yield { type: 'tool_use_end', id: state.id, input: parseArguments(state.arguments) };
      }
    }
  }

  finish(): ProviderEvent {
    const content: ContentBlock[] = [];
    if (this.#text.length > 0) content.push({ type: 'text', text: this.#text });
    for (const state of [...this.#tools.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s)) {
      content.push({
        type: 'tool_use', id: state.id, name: state.name, input: parseArguments(state.arguments),
      });
    }
    return {
      type: 'finish',
      reason: mapFinishReason(this.#finish),
      content,
      usage: this.#usage,
    };
  }

  get usage(): Usage {
    return this.#usage;
  }
}

/** Always parsed, never string-matched: escaping varies between models. */
function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function mapError(error: unknown): ProviderError {
  const status = (error as { status?: number } | undefined)?.status;
  const message = humanMessage(error);
  const raw = (error as { error?: unknown } | undefined)?.error ?? error;
  const base = { message, providerRaw: raw };

  if (status === 429) {
    return { ...base, kind: 'rate_limit', retryable: true };
  }
  if (status === 401 || status === 403) {
    return { ...base, kind: 'authentication', retryable: false };
  }
  if (status !== undefined && status >= 500) {
    return { ...base, kind: 'overloaded', retryable: true };
  }
  if (status !== undefined && status >= 400) {
    const text = message.toLowerCase();
    if (text.includes('context') || text.includes('maximum context') || text.includes('too many tokens')) {
      return { ...base, kind: 'context_length', retryable: false };
    }
    if (text.includes('content') && text.includes('filter')) {
      return { ...base, kind: 'content_filter', retryable: false };
    }
    return { ...base, kind: 'invalid_request', retryable: false };
  }
  const name = (error as { name?: string } | undefined)?.name ?? '';
  if (name.includes('Connection') || name.includes('Timeout')) {
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
