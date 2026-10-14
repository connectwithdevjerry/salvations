import { describe, expect, it } from 'vitest';
import { extractDocument, UnsupportedDocumentError } from './extract';
import { extractPdf, NotAPdfError } from './pdf';

/** A one-page PDF with a text stream, written by hand with a correct xref table. */
function pdf(text: string): Uint8Array {
  const content = `BT /F1 18 Tf 40 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('reading a PDF', () => {
  it('yields the text layer', async () => {
    expect(await extractPdf(pdf('Hello from a PDF'))).toContain('Hello from a PDF');
  });

  it('refuses a file that is not a PDF', async () => {
    await expect(extractPdf(new TextEncoder().encode('not a pdf'))).rejects.toThrow(NotAPdfError);
  });

  it('says so when a PDF has no text, rather than ingesting nothing', async () => {
    await expect(extractDocument(pdf(''), 'pdf')).rejects.toThrow(UnsupportedDocumentError);
    await expect(extractDocument(pdf(''), 'pdf')).rejects.toThrow(/no text/);
  });
});
