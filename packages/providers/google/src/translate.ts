/**
 * Wire translation for this vendor.
 *
 * A third distinct shape: turns are `contents` with `parts`, tool calls arrive
 * as structured objects rather than a JSON string, roles use `model` instead of
 * `assistant`, and function schemas accept only a restricted subset.
 */
import {
  buildToolNameMap, canonicalNameOf, emptyUsage, wireNameOf,
  type CanonicalMessage, type ContentBlock, type FinishReason, type GenerationRequest,
  type JsonSchema, type ModelCapabilities, type ProviderError, type ProviderEvent,
  type ToolNameMap, type Usage,
} from '@salvations/core';

export interface EncodedRequest {
  readonly body: Record<string, unknown>;
  readonly toolNames: ToolNameMap;
}

/**
 * Down-converts a JSON Schema to the subset this vendor accepts.
 *
 * Composition keywords are dropped rather than sent: an unsupported keyword is
 * rejected outright, and silently losing a CONSTRAINT is safer than losing the
 * whole tool — but it is a real loss, so it is logged by the caller, never
 * hidden.
 */
export function downConvertSchema(schema: JsonSchema): JsonSchema {
  const UNSUPPORTED = new Set([
    '$schema', '$id', '$ref', '$defs', 'definitions',
    'oneOf', 'allOf', 'not', 'if', 'then', 'else',
    'patternProperties', 'propertyNames', 'const', 'examples',
    'additionalProperties', 'dependentSchemas', 'unevaluatedProperties',
  ]);

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED.has(key)) continue;
      out[key] = walk(value);
    }
    return out;
  };

  return walk(schema) as JsonSchema;
}

const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');

function encodeParts(message: CanonicalMessage, tools: ToolNameMap): unknown[] {
  const parts: unknown[] = [];

  for (const block of message.content) {
    if (block.type === 'text' && block.text.length > 0) {
      parts.push({ text: block.text });
    } else if (block.type === 'tool_use') {
      // Arguments are a structured object here, not a JSON string.
      parts.push({ functionCall: { name: wireNameOf(tools, block.name), args: block.input ?? {} } });
    } else if (block.type === 'tool_result') {
      parts.push({
        functionResponse: {
          name: block.toolUseId,
          response: block.structured ?? { content: textOf(block.content) },
        },
      });
    }
    // Reasoning summaries are not sent back: they are our record, not state
    // this vendor can resume from.
  }

  return parts.length > 0 ? parts : [{ text: '' }];
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

  const body: Record<string, unknown> = {
    contents: request.messages.map((message) => ({
      // 'model', not 'assistant'.
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: encodeParts(message, toolNames),
    })),
    generationConfig: {
      maxOutputTokens: Math.min(request.maxOutputTokens, capabilities.maxOutputTokens),
      ...(request.stopSequences !== undefined && request.stopSequences.length > 0
        ? { stopSequences: [...request.stopSequences] }
        : {}),
      ...(request.structuredOutput !== undefined
        ? {
            responseMimeType: 'application/json',
            responseSchema: downConvertSchema(request.structuredOutput.schema),
          }
        : {}),
    },
  };

  if (request.system.length > 0) {
    body['systemInstruction'] = { parts: request.system.map((d) => ({ text: d.text })) };
  }

  if (request.tools.length > 0) {
    body['tools'] = [{
      functionDeclarations: request.tools.map((tool) => ({
        name: wireNameOf(toolNames, tool.name),
        description: tool.description,
        parameters: downConvertSchema(tool.inputSchema),
      })),
    }];
    body['toolConfig'] = {
      functionCallingConfig:
        request.toolChoice === 'none' ? { mode: 'NONE' }
        : typeof request.toolChoice === 'object' && capabilities.tools.forcedChoice
          ? { mode: 'ANY', allowedFunctionNames: [wireNameOf(toolNames, request.toolChoice.name)] }
          : { mode: 'AUTO' },
    };
  }

  return { body, toolNames };
}

export function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
      return 'content_filter';
    // Reciting training data is a refusal to produce the output, not a filter
    // on the input, and the remedies differ.
    case 'RECITATION': return 'refusal';
    default:
      return raw === null || raw === undefined || raw === 'FINISH_REASON_UNSPECIFIED'
        ? 'end_turn'
        : 'error';
  }
}

function mapUsage(raw: unknown): Usage {
  if (raw === null || typeof raw !== 'object') return emptyUsage;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const cached = num(u['cachedContentTokenCount']);
  return {
    // The prompt count INCLUDES cached tokens, so counting both double-bills.
    inputTokens: Math.max(0, num(u['promptTokenCount']) - cached),
    outputTokens: num(u['candidatesTokenCount']),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

interface ToolState { id: string; name: string; input: unknown }

export class StreamDecoder {
  readonly #toolNames: ToolNameMap;
  readonly #tools: ToolState[] = [];
  #text = '';
  #reasoning = '';
  #usage: Usage = emptyUsage;
  #finish: string | null = null;
  #started = false;

  constructor(toolNames: ToolNameMap) {
    this.#toolNames = toolNames;
  }

  *handle(chunk: Record<string, unknown>): Generator<ProviderEvent> {
    if (!this.#started) {
      this.#started = true;
      yield { type: 'start', messageId: String(chunk['responseId'] ?? '') };
    }

    const usage = chunk['usageMetadata'];
    if (usage !== undefined && usage !== null) this.#usage = mapUsage(usage);

    const candidate = (chunk['candidates'] as Record<string, unknown>[] | undefined)?.[0];
    if (candidate === undefined) return;

    const finish = candidate['finishReason'];
    if (typeof finish === 'string') this.#finish = finish;

    const content = candidate['content'] as Record<string, unknown> | undefined;
    for (const part of (content?.['parts'] ?? []) as Record<string, unknown>[]) {
      // A thought part is a reasoning summary, distinguished only by a flag on
      // an otherwise ordinary text part.
      if (part['thought'] === true) {
        const text = String(part['text'] ?? '');
        this.#reasoning += text;
        yield { type: 'reasoning_delta', text };
        continue;
      }

      if (typeof part['text'] === 'string' && part['text'].length > 0) {
        this.#text += part['text'];
        yield { type: 'text_delta', text: part['text'] };
        continue;
      }

      const call = part['functionCall'] as Record<string, unknown> | undefined;
      if (call !== undefined) {
        // No call id is supplied, so one is synthesised. It must be stable
        // within the turn because tool results are correlated by it.
        const id = String(call['id'] ?? `call_${this.#tools.length}`);
        const name = canonicalNameOf(this.#toolNames, String(call['name'] ?? ''));
        const input = call['args'] ?? {};
        this.#tools.push({ id, name, input });
        yield { type: 'tool_use_start', id, name };
        yield { type: 'tool_use_end', id, input };
      }
    }

    if (this.#finish !== null) yield { type: 'usage', usage: this.#usage };
  }

  finish(): ProviderEvent {
    const content: ContentBlock[] = [];
    if (this.#reasoning.length > 0) {
      content.push({ type: 'reasoning', summary: this.#reasoning, redacted: false });
    }
    if (this.#text.length > 0) content.push({ type: 'text', text: this.#text });
    for (const tool of this.#tools) {
      content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input });
    }
    return {
      type: 'finish',
      // A turn containing a function call ends for tool use even when the
      // vendor reports a plain STOP.
      reason: this.#tools.length > 0 && mapFinishReason(this.#finish) === 'end_turn'
        ? 'tool_use'
        : mapFinishReason(this.#finish),
      content,
      usage: this.#usage,
    };
  }
}

export function mapError(status: number, payload: unknown): ProviderError {
  const error = (payload as { error?: { message?: string; status?: string } } | undefined)?.error;
  const message = error?.message ?? `Provider request failed with status ${status}`;
  const base = { message, providerRaw: payload };

  if (status === 429) return { ...base, kind: 'rate_limit', retryable: true };
  if (status === 401 || status === 403) return { ...base, kind: 'authentication', retryable: false };
  if (status >= 500) return { ...base, kind: 'overloaded', retryable: true };
  if (status >= 400) {
    const text = message.toLowerCase();
    if (text.includes('token') && (text.includes('exceed') || text.includes('too many'))) {
      return { ...base, kind: 'context_length', retryable: false };
    }
    return { ...base, kind: 'invalid_request', retryable: false };
  }
  return { ...base, kind: 'unknown', retryable: false };
}
