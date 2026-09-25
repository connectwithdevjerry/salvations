import { describe, expect, it } from 'vitest';
import { chunkText, DEFAULT_CHUNKING, maxChunkLength } from './chunk';
import { extractText, kindOf, stripHtml, UnsupportedDocumentError } from './extract';
import { rankChunks, RELEVANCE_FLOOR, similarityOf } from './retrieval';
import { titleFromFileName } from './document';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('reading uploads', () => {
  it('recognises text formats by extension before declared type', () => {
    // Browsers declare octet-stream for anything they do not know, which
    // includes Markdown. The name is the better witness.
    expect(kindOf('notes.md', 'application/octet-stream')).toBe('markdown');
    expect(kindOf('data.csv', undefined)).toBe('csv');
    expect(kindOf('page.html', 'text/html')).toBe('html');
    expect(kindOf('blob', 'text/plain; charset=utf-8')).toBe('text');
  });

  it('does not guess at a format it cannot read', () => {
    expect(kindOf('deck.pdf', 'application/pdf')).toBeUndefined();
    expect(kindOf('report.docx', undefined)).toBeUndefined();
  });

  it('refuses binary that wears a text extension', () => {
    // Lenient decoding would store a searchable document of replacement
    // characters, which looks ingested and answers nothing.
    expect(() => extractText(new Uint8Array([0xff, 0xfe, 0x00, 0x41]), 'text'))
      .toThrow(UnsupportedDocumentError);
    expect(() => extractText(encode('abc\0def'), 'text')).toThrow(UnsupportedDocumentError);
  });

  it('normalises line endings and drops a byte-order mark', () => {
    expect(extractText(encode('﻿one\r\ntwo\rthree'), 'text')).toBe('one\ntwo\nthree');
  });

  it('turns HTML into paragraphs, not one long line', () => {
    const html = '<html><head><style>p{}</style><script>x()</script></head>'
      + '<body><h1>Pricing &amp; terms</h1><p>Starter is &#36;10.</p><p>Pro is $20.</p>'
      + '<ul><li>One</li><li>Two</li></ul></body></html>';
    const text = stripHtml(html);
    expect(text).toContain('Pricing & terms');
    expect(text).toContain('Starter is $10.');
    expect(text).not.toContain('x()');
    expect(text).not.toContain('p{}');
    // Blocks became paragraph breaks, so the chunker sees structure.
    expect(text.split('\n\n').length).toBeGreaterThanOrEqual(3);
  });

  it('titles a document from its file name', () => {
    expect(titleFromFileName('pricing_sheet-2026.md')).toBe('pricing sheet 2026');
    expect(titleFromFileName('.hidden')).toBe('.hidden');
  });
});

describe('chunking', () => {
  const paragraph = (n: number, words = 40): string =>
    Array.from({ length: words }, (_, i) => `p${n}w${i}`).join(' ') + '.';

  it('produces nothing from nothing', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n\n \n')).toEqual([]);
  });

  it('keeps a short document as one chunk', () => {
    expect(chunkText('Just one paragraph.')).toEqual([{ index: 0, content: 'Just one paragraph.' }]);
  });

  it('never exceeds the documented maximum', () => {
    const text = Array.from({ length: 40 }, (_, i) => paragraph(i)).join('\n\n');
    const options = { target: 300, overlap: 60 };
    const chunks = chunkText(text, options);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(maxChunkLength(options));
    // Indexes are the reading order.
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('loses no paragraph across boundaries', () => {
    const text = Array.from({ length: 30 }, (_, i) => paragraph(i, 20)).join('\n\n');
    const joined = chunkText(text, { target: 250, overlap: 40 }).map((c) => c.content).join('\n');
    for (let i = 0; i < 30; i += 1) expect(joined).toContain(`p${i}w19.`);
  });

  it('overlaps consecutive chunks so a boundary fact is whole somewhere', () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i, 30)).join('\n\n');
    const chunks = chunkText(text, { target: 400, overlap: 80 });
    expect(chunks.length).toBeGreaterThan(2);
    const first = chunks[0]?.content ?? '';
    const second = chunks[1]?.content ?? '';
    // The second chunk opens with words that closed the first.
    const opening = second.split(' ').slice(0, 3).join(' ');
    expect(first).toContain(opening);
    // And opens on a word boundary, never mid-token.
    expect(second.startsWith(' ')).toBe(false);
  });

  it('cuts a paragraph that never ends without dropping text', () => {
    const wall = 'x'.repeat(5_000);
    const chunks = chunkText(wall, { target: 1_000, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.map((c) => c.content.replace(/\s/g, '')).join('').length)
      .toBeGreaterThanOrEqual(5_000);
  });

  it('cuts long paragraphs at sentence ends when it can', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} says something useful.`);
    const chunks = chunkText(sentences.join(' '), { target: 120, overlap: 0 });
    for (const chunk of chunks) expect(chunk.content.endsWith('.')).toBe(true);
  });

  it('has defaults a person would recognise', () => {
    expect(DEFAULT_CHUNKING.target).toBeGreaterThan(DEFAULT_CHUNKING.overlap * 4);
  });
});

describe('ranking chunks', () => {
  const items = [
    { id: 'a', content: 'Our refund policy: full refund within 30 days of purchase.' },
    { id: 'b', content: 'The office is closed on public holidays.' },
    { id: 'c', content: 'Refunds after 30 days are store credit only.' },
  ];

  it('ranks by word overlap when there are no vectors', () => {
    const ranked = rankChunks('refund policy 30 days', items);
    expect(ranked[0]?.item.id).toBe('a');
    expect(ranked.map((r) => r.item.id)).not.toContain('b');
  });

  it('drops chunks below the relevance floor rather than returning everything', () => {
    expect(rankChunks('zebra', items)).toEqual([]);
    expect(RELEVANCE_FLOOR).toBeGreaterThan(0);
  });

  it('lets similarity dominate when vectors are present', () => {
    const ranked = rankChunks('money back', [
      { id: 'a', content: 'Our refund policy.', similarity: 0.9 },
      { id: 'b', content: 'money back is not mentioned here at all', similarity: 0.1 },
    ]);
    expect(ranked[0]?.item.id).toBe('a');
  });

  it('never compares vectors of different lengths', () => {
    expect(similarityOf([1, 0], [1, 0, 0])).toEqual({});
    expect(similarityOf(undefined, [1])).toEqual({});
    expect(similarityOf([1, 0], [1, 0]).similarity).toBeCloseTo(1);
  });
});
