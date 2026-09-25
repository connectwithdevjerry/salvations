/**
 * Getting text out of what was uploaded.
 *
 * Only text-shaped formats, deliberately. A PDF or a Word file needs a parser
 * that is its own project, and a half-working one produces documents that
 * LOOK ingested and answer nothing — the worst outcome, because the person
 * believes the agent has read something it has not. Refusing says so at
 * upload time, with the fix in the message.
 */

export type TextKind = 'text' | 'markdown' | 'html' | 'csv' | 'json';

export class UnsupportedDocumentError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UnsupportedDocumentError';
  }
}

const BY_EXTENSION: Readonly<Record<string, TextKind>> = {
  txt: 'text', text: 'text', log: 'text',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html',
  csv: 'csv', tsv: 'csv',
  json: 'json',
};

const BY_MIME: Readonly<Record<string, TextKind>> = {
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'application/json': 'json',
};

/** Formats named in the refusal, so the message doubles as the instructions. */
export const SUPPORTED_FORMATS = 'plain text, Markdown, HTML, CSV or JSON';

/**
 * Which kind of text this is, from the name first and the declared type second.
 *
 * The name wins because browsers declare `application/octet-stream` for
 * anything they do not recognise, and Markdown is something they mostly do
 * not. Undefined means "not something we can read", never a guess.
 */
export function kindOf(fileName: string, mimeType: string | undefined): TextKind | undefined {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension !== undefined && BY_EXTENSION[extension] !== undefined) {
    return BY_EXTENSION[extension];
  }
  const declared = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return BY_MIME[declared];
}

/**
 * Text from bytes.
 *
 * Decoding is strict: bytes that are not UTF-8 are almost always a binary
 * file with a text extension, and decoding them leniently produces a document
 * of replacement characters that is searchable and meaningless.
 */
export function extractText(bytes: Uint8Array, kind: TextKind): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UnsupportedDocumentError(
      `That file is not text. Upload ${SUPPORTED_FORMATS} — a PDF or Word document `
      + 'can be exported as one of those first.',
    );
  }

  // A NUL byte never appears in text. Its presence is a binary file that
  // happened to survive decoding.
  if (text.includes('\0')) {
    throw new UnsupportedDocumentError(
      `That file contains binary data. Upload ${SUPPORTED_FORMATS}.`,
    );
  }

  const normalised = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  return kind === 'html' ? stripHtml(normalised) : normalised;
}

/**
 * HTML to readable text.
 *
 * Block boundaries become paragraph breaks BEFORE the tags go, so the chunker
 * still sees paragraphs rather than one run-on line. Scripts and styles are
 * removed with their contents: they are code, not knowledge.
 */
export function stripHtml(html: string): string {
  const withoutCode = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const withBreaks = withoutCode
    .replace(/<\s*(br)\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? whole;
  });
}
