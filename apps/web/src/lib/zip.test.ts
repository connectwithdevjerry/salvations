import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { deflateRawSync } from 'node:zlib';
import { readZip, textOf } from './zip';

/** Builds a small archive by hand, so the reader is tested against the format and not against itself. */
function zip(files: { path: string; text: string; deflate?: boolean }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.path);
    const data = new TextEncoder().encode(file.text);
    const body = file.deflate === true ? new Uint8Array(deflateRawSync(data)) : data;
    const method = file.deflate === true ? 8 : 0;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true); lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, body);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(8, 0x800, true); cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    c.set(name, 46);
    central.push(c);
    offset += local.length + body.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

describe('reading a zip', () => {
  it('reads stored and deflated entries by path', () => {
    const entries = readZip(zip([
      { path: 'workspace/SOUL.md', text: '# Soul\nWarm and brief.' },
      { path: 'workspace/memory/2026-09-01.md', text: 'Met Sam about rice.'.repeat(50), deflate: true },
    ]));
    expect(entries.map((e) => e.path)).toEqual(['workspace/SOUL.md', 'workspace/memory/2026-09-01.md']);
    expect(textOf(entries[0]!)).toBe('# Soul\nWarm and brief.');
    expect(textOf(entries[1]!)).toContain('Met Sam about rice.');
  });

  it('refuses something that is not a zip', () => {
    expect(() => readZip(new TextEncoder().encode('hello'))).toThrow('not a zip');
  });

  it('leaves out entries above the size limit', () => {
    const entries = readZip(zip([{ path: 'big.md', text: 'x'.repeat(500) }, { path: 'small.md', text: 'ok' }]), { maxEntryBytes: 100 });
    expect(entries.map((e) => e.path)).toEqual(['small.md']);
  });
});
