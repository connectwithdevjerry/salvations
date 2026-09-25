/**
 * Folds a provider event stream into an assertable summary.
 *
 * Every adapter must produce the SAME shape here from wildly different wire
 * formats — that equivalence is the whole point of the abstraction.
 */
import type { ContentBlock, ProviderEvent, Usage, FinishReason, ProviderError } from '@salvations/core';

export interface CollectedStream {
  readonly events: readonly ProviderEvent[];
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: readonly { id: string; name: string; input: unknown }[];
  readonly content: readonly ContentBlock[];
  readonly usage?: Usage | undefined;
  readonly finishReason?: FinishReason | undefined;
  readonly artifacts?: Readonly<Record<string, unknown>> | undefined;
  readonly error?: ProviderError | undefined;
}

export async function collect(stream: AsyncIterable<ProviderEvent>): Promise<CollectedStream> {
  const events: ProviderEvent[] = [];
  let text = '';
  let reasoning = '';
  const toolCalls: { id: string; name: string; input: unknown }[] = [];
  let content: readonly ContentBlock[] = [];
  let usage: Usage | undefined;
  let finishReason: FinishReason | undefined;
  let artifacts: Readonly<Record<string, unknown>> | undefined;
  let error: ProviderError | undefined;

  for await (const event of stream) {
    events.push(event);
    switch (event.type) {
      case 'text_delta': text += event.text; break;
      case 'reasoning_delta': reasoning += event.text; break;
      case 'tool_use_end': {
        const started = events.find(
          (e): e is Extract<ProviderEvent, { type: 'tool_use_start' }> =>
            e.type === 'tool_use_start' && e.id === event.id,
        );
        toolCalls.push({ id: event.id, name: started?.name ?? '', input: event.input });
        break;
      }
      case 'usage': usage = event.usage; break;
      case 'finish':
        finishReason = event.reason;
        content = event.content;
        usage = event.usage;
        if (event.providerArtifacts !== undefined) artifacts = event.providerArtifacts;
        break;
      case 'error': error = event.error; break;
      default: break;
    }
  }

  return { events, text, reasoning, toolCalls, content, usage, finishReason, artifacts, error };
}

/** Collects a stream that is expected to fail, without throwing. */
export async function collectSettled(
  stream: AsyncIterable<ProviderEvent>,
): Promise<CollectedStream & { threw?: unknown | undefined }> {
  try {
    return await collect(stream);
  } catch (threw) {
    return {
      events: [], text: '', reasoning: '', toolCalls: [], content: [], threw,
    };
  }
}
