import { describe, expect, it } from 'vitest';
import { readZip, textOf } from './zip';
import { zip } from './zip.fixture';

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
