/**
 * Text from a PDF.
 *
 * Through pdf.js, in its serverless packaging: no canvas, no fonts to load,
 * just the text layer in reading order. A PDF without a text layer, a scan,
 * yields nothing, and nothing is said so rather than ingested as an empty
 * document that looks read.
 */
import { extractText as pdfText, getDocumentProxy } from 'unpdf';

export class NotAPdfError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'NotAPdfError';
  }
}

export async function extractPdf(bytes: Uint8Array): Promise<string> {
  let document;
  try {
    document = await getDocumentProxy(new Uint8Array(bytes));
  } catch (caught) {
    throw new NotAPdfError(`That PDF could not be opened: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const { text } = await pdfText(document, { mergePages: true });
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
