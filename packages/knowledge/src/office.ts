/**
 * Text from a Word document.
 *
 * A .docx is a zip with the body in `word/document.xml`. The text is in
 * `<w:t>` runs inside `<w:p>` paragraphs; tabs and line breaks are their
 * own elements. That is all a knowledge base needs: paragraphs in order,
 * with the words in them. Tables come out row by row with cells separated
 * by a tab, and headers, footers and comments are left out, because they
 * repeat on every page and say nothing the body does not.
 */
import { readZip } from './zip';

export class NotAWordDocumentError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'NotAWordDocumentError';
  }
}

export function extractDocx(bytes: Uint8Array): string {
  let entries;
  try {
    entries = readZip(bytes, { maxEntries: 500, maxEntryBytes: 50_000_000 });
  } catch (caught) {
    throw new NotAWordDocumentError(`That is not a Word document: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const body = entries.find((e) => e.path === 'word/document.xml');
  if (body === undefined) throw new NotAWordDocumentError('That is not a Word document: it has no word/document.xml inside.');
  return textOfWordXml(new TextDecoder('utf-8').decode(body.bytes));
}

/** The paragraphs of a WordprocessingML body, as text. */
export function textOfWordXml(xml: string): string {
  const paragraphs: string[] = [];
  // Rows become one paragraph each, cells tab-separated, so a price list
  // stays a price list.
  const withRows = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((m) => paragraphText(m[0]).replace(/\n+/g, ' ').trim());
    return `<w:p><w:t>${escape(cells.join('\t'))}</w:t></w:p>`;
  });
  for (const match of withRows.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g)) {
    paragraphs.push(match[1] === undefined ? '' : paragraphText(match[1]));
  }
  return paragraphs
    .map((p) => p.replace(/[ \t]+$/gm, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function paragraphText(inner: string): string {
  let text = '';
  for (const match of inner.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g)) {
    const whole = match[0];
    if (whole.startsWith('<w:t')) {
      if (whole.startsWith('<w:tab')) text += '\t';
      else text += decode(match[1] ?? '');
    } else {
      text += '\n';
    }
  }
  return text;
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }[lower] ?? whole;
  });
}
