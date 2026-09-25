import { describe, expect, it } from 'vitest';
import type { BlobStore } from '@salvations/core';
import {
  MAX_ACCEPTED_RESULT_BYTES, normaliseToolResult, refusalResult,
} from './results';

function fakeBlobs(): BlobStore & { readonly stored: Map<string, { mime: string; bytes: number }> } {
  const stored = new Map<string, { mime: string; bytes: number }>();
  return {
    stored,
    put: async (key, data, mime) => { stored.set(key, { mime, bytes: data.byteLength }); },
    get: async () => new Uint8Array(),
    delete: async () => undefined,
  };
}

const OPTS = { blobKeyPrefix: 'runs/run_1/tools/t-1' };

describe('content translation', () => {
  it('passes text through', async () => {
    const result = await normaliseToolResult({ content: [{ type: 'text', text: 'hello' }] }, OPTS);
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.isError).toBe(false);
  });

  it('spills an image to blob storage instead of inlining base64', async () => {
    // A base64 screenshot in a prompt is enormous and useless to a text model.
    const blobs = fakeBlobs();
    const data = Buffer.from('not-really-a-png').toString('base64');
    const result = await normaliseToolResult(
      { content: [{ type: 'image', data, mimeType: 'image/png' }] },
      { ...OPTS, blobs },
    );

    expect(result.content[0]).toMatchObject({ type: 'blob_ref', mime: 'image/png' });
    expect(blobs.stored.size).toBe(1);
  });

  it('describes a binary block rather than dropping it when there is nowhere to put it', async () => {
    const result = await normaliseToolResult(
      { content: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }] },
      OPTS,
    );
    expect(result.content).toEqual([{ type: 'text', text: '[audio omitted: audio/wav]' }]);
  });

  it('renders a resource link as a pointer the model can ask for', async () => {
    const result = await normaliseToolResult(
      { content: [{ type: 'resource_link', uri: 'file:///a.txt', name: 'notes' }] },
      OPTS,
    );
    expect(result.content).toEqual([{ type: 'text', text: '[resource: notes <file:///a.txt>]' }]);
  });

  it('inlines an embedded text resource but names a binary one', async () => {
    const inline = await normaliseToolResult(
      { content: [{ type: 'resource', resource: { uri: 'x:1', text: 'body' } }] }, OPTS,
    );
    expect(inline.content).toEqual([{ type: 'text', text: 'body' }]);

    const binary = await normaliseToolResult(
      { content: [{ type: 'resource', resource: { uri: 'x:2', blob: 'AAAA' } }] }, OPTS,
    );
    expect(binary.content).toEqual([{ type: 'text', text: '[embedded resource <x:2>]' }]);
  });

  it('describes an unrecognised block rather than silently losing it', async () => {
    // Dropping content the server sent makes a working tool look broken.
    const result = await normaliseToolResult({ content: [{ type: 'video_2027' }] }, OPTS);
    expect(result.content).toEqual([{ type: 'text', text: '[unsupported content block: video_2027]' }]);
  });

  it('survives a malformed result without throwing', async () => {
    expect((await normaliseToolResult(undefined, OPTS)).content).toEqual([]);
    expect((await normaliseToolResult({ content: 'not an array' }, OPTS)).content).toEqual([]);
    expect((await normaliseToolResult({ content: [null, 7] }, OPTS)).content).toEqual([]);
  });

  it('keeps structured content when the tool declared an output schema', async () => {
    const result = await normaliseToolResult(
      { content: [], structuredContent: { id: 42 } }, OPTS,
    );
    expect(result.structured).toEqual({ id: 42 });
  });
});

describe('size limits', () => {
  it('spills an oversized result and leaves the model a usable head', async () => {
    const blobs = fakeBlobs();
    const long = 'x'.repeat(2_000);
    const result = await normaliseToolResult(
      { content: [{ type: 'text', text: long }] },
      { ...OPTS, blobs, maxInlineBytes: 500 },
    );

    expect(result.truncated).toBe(true);
    expect(result.spilledTo).toBe('runs/run_1/tools/t-1/result.json');
    expect(blobs.stored.has('runs/run_1/tools/t-1/result.json')).toBe(true);
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text.length).toBeLessThan(long.length);
    expect(text).toMatch(/result truncated/);
  });

  it('keeps an oversized result inline when there is nowhere to spill it', async () => {
    // Better a large prompt than a silently empty tool result.
    const result = await normaliseToolResult(
      { content: [{ type: 'text', text: 'y'.repeat(2_000) }] },
      { ...OPTS, maxInlineBytes: 500 },
    );
    expect(result.spilledTo).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  it('rejects an absurd payload outright rather than translating it block by block', async () => {
    const huge = { content: [{ type: 'text', text: 'z'.repeat(MAX_ACCEPTED_RESULT_BYTES + 1) }] };
    const result = await normaliseToolResult(huge, OPTS);

    expect(result.isError).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
      .toMatch(/exceeds the .* limit/);
  });

  it('reports the byte size it measured', async () => {
    const result = await normaliseToolResult({ content: [{ type: 'text', text: 'abc' }] }, OPTS);
    expect(result.bytes).toBe(JSON.stringify({ content: [{ type: 'text', text: 'abc' }] }).length);
  });
});

describe('refusals', () => {
  it('reaches the model as an error result carrying the reason', async () => {
    const refusal = refusalResult('Denied by policy.');
    expect(refusal.isError).toBe(true);
    expect(refusal.content).toEqual([{ type: 'text', text: 'Denied by policy.' }]);
    expect(refusal.truncated).toBe(false);
  });
});
