import { describe, expect, it } from 'vitest';
import {
  artifactsForModel, messageText, providerKey, shouldReplayArtifact, toolUseBlocks,
  type ContentBlock, type ProviderArtifacts,
} from './conversation';

/**
 * The replay rule is the acceptance test for cross-vendor continuation (AC-6).
 * Replaying a foreign model's reasoning state corrupts a conversation; dropping
 * it is always safe.
 */
describe('provider artifact replay', () => {
  const artifacts: ProviderArtifacts = {
    'vendor-a:model-1': { blocks: ['opaque-a'] },
    'vendor-b:model-9': { items: ['opaque-b'] },
  };

  it('replays an artifact produced by the same provider and model', () => {
    const key = providerKey('vendor-a', 'model-1');
    expect(shouldReplayArtifact('vendor-a:model-1', key)).toBe(true);
    expect(artifactsForModel(artifacts, key)).toEqual({ blocks: ['opaque-a'] });
  });

  it('drops artifacts when the provider changes', () => {
    expect(artifactsForModel(artifacts, providerKey('vendor-c', 'model-1'))).toBeUndefined();
  });

  it('drops artifacts when only the model changes within one provider', () => {
    // Same vendor, different model: reasoning state is model-bound, not vendor-bound.
    expect(artifactsForModel(artifacts, providerKey('vendor-a', 'model-2'))).toBeUndefined();
  });

  it('is safe when a message carries no artifacts at all', () => {
    expect(artifactsForModel(undefined, providerKey('vendor-a', 'model-1'))).toBeUndefined();
  });

  it('keeps each model’s artifacts separate as a conversation moves between vendors', () => {
    // A conversation that ran on A, then B, then back to A must still replay A's state.
    const onA = artifactsForModel(artifacts, providerKey('vendor-a', 'model-1'));
    const onB = artifactsForModel(artifacts, providerKey('vendor-b', 'model-9'));
    expect(onA).not.toEqual(onB);
    expect(onA).toBeDefined();
    expect(onB).toBeDefined();
  });
});

describe('content helpers', () => {
  it('flattens nested tool results and reasoning summaries into text', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'checking' },
      { type: 'reasoning', summary: 'considered options', redacted: false },
      { type: 'tool_result', toolUseId: 't1', isError: false, content: [{ type: 'text', text: 'result' }] },
      { type: 'image', blobKey: 'k', mime: 'image/png' },
    ];
    expect(messageText(content)).toBe('checking\nconsidered options\nresult');
  });

  it('omits redacted reasoning that carries no summary', () => {
    expect(messageText([{ type: 'reasoning', redacted: true }])).toBe('');
  });

  it('extracts tool_use blocks in order', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'x' },
      { type: 'tool_use', id: 'a', name: 'one', input: {} },
      { type: 'tool_use', id: 'b', name: 'two', input: {} },
    ];
    expect(toolUseBlocks(content).map((b) => b.id)).toEqual(['a', 'b']);
  });
});
