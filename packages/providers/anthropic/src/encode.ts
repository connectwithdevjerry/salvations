/**
 * Canonical -> wire translation.
 *
 * Everything vendor-specific about how a request is shaped lives here, so the
 * runtime never has to know any of it.
 */
import {
  artifactsForModel, buildToolNameMap, providerKey, wireNameOf,
  type CanonicalMessage, type ContentBlock, type GenerationRequest,
  type ModelCapabilities, type ToolDeclaration, type ToolNameMap,
} from '@salvations/core';

export interface EncodedRequest {
  readonly body: Record<string, unknown>;
  readonly toolNames: ToolNameMap;
}

const isReasoning = (block: ContentBlock): boolean => block.type === 'reasoning';

function encodeContent(blocks: readonly ContentBlock[], tools: ToolNameMap): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: block.text });
        break;
      case 'tool_use':
        out.push({
          type: 'tool_use',
          id: block.id,
          name: wireNameOf(tools, block.name),
          input: block.input,
        });
        break;
      case 'tool_result':
        out.push({
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: encodeContent(block.content, tools),
          is_error: block.isError,
        });
        break;
      case 'image':
      case 'document':
      case 'blob_ref':
        // Binary content is referenced by blob key in the canonical format;
        // resolving it to bytes belongs to the runtime, not the adapter.
        out.push({ type: 'text', text: `[${block.type} omitted]` });
        break;
      case 'reasoning':
        // Reasoning is replayed from the opaque artifact, not rebuilt from a
        // summary — a summary is lossy and would be rejected as tampered.
        break;
    }
  }
  return out;
}

/**
 * Encodes one turn.
 *
 * When this model produced the turn, its opaque reasoning blocks are replayed
 * VERBATIM ahead of the visible content. When another model produced it, they
 * are dropped entirely: foreign reasoning state is meaningless here, and
 * replaying it corrupts the conversation.
 */
function encodeMessage(
  message: CanonicalMessage,
  ownKey: string,
  tools: ToolNameMap,
): Record<string, unknown> {
  const visible = encodeContent(message.content.filter((b) => !isReasoning(b)), tools);

  const artifact = artifactsForModel(message.providerArtifacts, ownKey as never) as
    | { blocks?: unknown[] }
    | undefined;

  const content =
    artifact?.blocks !== undefined && message.role === 'assistant'
      ? [...artifact.blocks, ...visible]
      : visible;

  return {
    role: message.role === 'tool' ? 'user' : message.role,
    // A turn whose only content was dropped still has to exist, or the
    // alternation the API requires breaks.
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
  };
}

function encodeTools(
  declarations: readonly ToolDeclaration[],
  names: ToolNameMap,
): unknown[] {
  return declarations.map((tool) => ({
    name: wireNameOf(names, tool.name),
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export function encodeRequest(
  request: GenerationRequest,
  modelId: string,
  capabilities: ModelCapabilities,
): EncodedRequest {
  const ownKey = providerKey('anthropic', modelId);
  const toolNames = buildToolNameMap(
    request.tools.map((t) => t.name),
    { namePattern: capabilities.tools.namePattern, maxNameLength: capabilities.tools.maxNameLength },
  );

  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: Math.min(request.maxOutputTokens, capabilities.maxOutputTokens),
    // Always. A non-streaming call cannot be turned back into a stream, and on
    // a short-lived function it is indistinguishable from a hang.
    stream: true,
    system: request.system.map((directive) => ({ type: 'text', text: directive.text })),
    messages: request.messages.map((m) => encodeMessage(m, ownKey, toolNames)),
  };

  if (request.tools.length > 0) {
    body['tools'] = encodeTools(request.tools, toolNames);
    if (request.toolChoice === 'none') {
      body['tool_choice'] = { type: 'none' };
    } else if (typeof request.toolChoice === 'object') {
      // Reading the capability rather than trying and handling a 400.
      body['tool_choice'] = capabilities.tools.forcedChoice
        ? { type: 'tool', name: wireNameOf(toolNames, request.toolChoice.name) }
        : { type: 'auto' };
    } else {
      body['tool_choice'] = { type: 'auto' };
    }
  }

  if (request.reasoning !== undefined && capabilities.reasoning.supported) {
    // Adaptive rather than a fixed token budget: an explicit budget is rejected
    // outright on current models.
    if (capabilities.reasoning.mode === 'adaptive') {
      body['thinking'] = {
        type: 'adaptive',
        ...(request.reasoning.display !== undefined ? { display: request.reasoning.display } : {}),
      };
    }
    if (request.reasoning.effort !== undefined && capabilities.reasoning.effortLevels !== undefined) {
      body['output_config'] = { effort: request.reasoning.effort };
    }
  }

  if (request.structuredOutput !== undefined) {
    body['output_config'] = {
      ...(body['output_config'] as object | undefined),
      format: { type: 'json_schema', schema: request.structuredOutput.schema },
    };
  }

  if (request.stopSequences !== undefined && request.stopSequences.length > 0) {
    body['stop_sequences'] = [...request.stopSequences];
  }

  applyCacheBreakpoints(body, request, capabilities);

  return { body, toolNames };
}

/**
 * Marks cacheable prefix boundaries.
 *
 * Caching here is prefix-match, so a marker only helps if everything before it
 * is byte-stable. The assembler guarantees that; this just places the markers,
 * capped at what the model accepts.
 */
function applyCacheBreakpoints(
  body: Record<string, unknown>,
  request: GenerationRequest,
  capabilities: ModelCapabilities,
): void {
  if (capabilities.promptCache.strategy !== 'explicit_breakpoints') return;
  const hints = request.cacheHints?.breakpointsAfter;
  if (hints === undefined || hints.length === 0) return;

  const max = capabilities.promptCache.maxBreakpoints ?? 4;
  const messages = body['messages'] as Record<string, unknown>[];

  for (const index of hints.slice(0, max)) {
    const message = messages[index];
    if (message === undefined) continue;
    const content = message['content'] as Record<string, unknown>[];
    const last = content.at(-1);
    if (last !== undefined) last['cache_control'] = { type: 'ephemeral' };
  }
}
