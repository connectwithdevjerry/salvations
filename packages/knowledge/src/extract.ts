/**
 * Getting text out of what was uploaded.
 *
 * Text-shaped formats are decoded here. PDF and Word go through their own
 * extractors, each of which refuses by name when the file is not what its
 * extension says, or when a PDF turns out to be a scan with no text in it.
 * A document that LOOKS ingested and answers nothing is the worst outcome,
 * because the person believes the agent has read something it has not; so
 * every path either yields the words or says why it cannot.
 */
import { extractDocx, NotAWordDocumentError } from './office';
import { extractPdf, NotAPdfError } from './pdf';

export type TextKind = 'text' | 'markdown' | 'html' | 'csv' | 'json';
export type DocumentKind = TextKind | 'pdf' | 'docx';

export class UnsupportedDocumentError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UnsupportedDocumentError';
  }
}

const BY_EXTENSION: Readonly<Record<string, DocumentKind>> = {
  txt: 'text', text: 'text', log: 'text',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html',
  csv: 'csv', tsv: 'csv',
  json: 'json',
  pdf: 'pdf',
  docx: 'docx',
};

const BY_MIME: Readonly<Record<string, DocumentKind>> = {
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/** Formats named in the refusal, so the message doubles as the instructions. */
export const SUPPORTED_FORMATS = 'PDF, Word (.docx), plain text, Markdown, HTML, CSV or JSON';

/** The `accept` list for a file input, from the same table the server reads. */
export const ACCEPTED_UPLOADS = [
  ...Object.keys(BY_EXTENSION).map((e) => `.${e}`),
  ...Object.keys(BY_MIME),
].join(',');

/**
 * Which kind of text this is, from the name first and the declared type second.
 *
 * The name wins because browsers declare `application/octet-stream` for
 * anything they do not recognise, and Markdown is something they mostly do
 * not. Undefined means "not something we can read", never a guess.
 */
export function kindOf(fileName: string, mimeType: string | undefined): DocumentKind | undefined {
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
      `That file is not text. Upload ${SUPPORTED_FORMATS}.`,
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
 * Text from any upload we read, by kind.
 *
 * The binary formats' own errors become the one refusal type the service
 * turns into a message, so a .docx that is really a .doc, or a PDF that is
 * a photograph of a page, are explained the same way a binary .txt is.
 */
export async function extractDocument(bytes: Uint8Array, kind: DocumentKind): Promise<string> {
  if (kind === 'pdf') {
    let text: string;
    try {
      text = await extractPdf(bytes);
    } catch (caught) {
      if (caught instanceof NotAPdfError) throw new UnsupportedDocumentError(caught.message);
      throw caught;
    }
    if (text === '') {
      throw new UnsupportedDocumentError(
        'That PDF has no text in it, only images of pages. Run it through OCR, or export the original as a PDF with text.',
      );
    }
    return text;
  }
  if (kind === 'docx') {
    try {
      return extractDocx(bytes);
    } catch (caught) {
      if (caught instanceof NotAWordDocumentError) {
        throw new UnsupportedDocumentError(`${caught.message} An older .doc file can be saved as .docx in Word first.`);
      }
      throw caught;
    }
  }
  return extractText(bytes, kind);
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
