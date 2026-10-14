import { describe, expect, it } from 'vitest';
import { extractDocx, NotAWordDocumentError, textOfWordXml } from './office';
import { zip } from './zip.fixture';

const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

describe('reading a Word document', () => {
  it('yields paragraphs in order, with runs joined and breaks kept', () => {
    const xml = doc(
      '<w:p><w:r><w:t>Price</w:t></w:r><w:r><w:t xml:space="preserve"> list</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Rice</w:t><w:tab/><w:t>&#8358;45,000</w:t><w:br/><w:t>per bag</w:t></w:r></w:p>'
      + '<w:p/>',
    );
    expect(textOfWordXml(xml)).toBe('Price list\nRice\t₦45,000\nper bag');
  });

  it('keeps a table row on one line with tabs between cells', () => {
    const xml = doc(
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>Beans</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12 &amp; up</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    );
    expect(textOfWordXml(xml)).toBe('Item\tCost\nBeans\t12 & up');
  });

  it('opens the archive and finds the body', () => {
    const archive = zip([
      { path: '[Content_Types].xml', text: '<Types/>' },
      { path: 'word/document.xml', text: doc('<w:p><w:r><w:t>Hello from Word</w:t></w:r></w:p>'), deflate: true },
    ]);
    expect(extractDocx(archive)).toBe('Hello from Word');
  });

  it('says what is wrong with something that is not a Word document', () => {
    expect(() => extractDocx(new TextEncoder().encode('%PDF-1.4'))).toThrow(NotAWordDocumentError);
    expect(() => extractDocx(zip([{ path: 'readme.txt', text: 'x' }]))).toThrow(/no word\/document.xml/);
  });
});
