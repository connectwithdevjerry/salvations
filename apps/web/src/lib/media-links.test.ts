import { describe, expect, it } from 'vitest';
import { isMediaLine, mediaLink, mediaLinksIn, mediaTokenMatches } from './media-links';

const BASE = 'https://hive.example';
const SECRET = 'a-secret-long-enough-for-the-purpose';

describe('media links', () => {
  it('signs the id and verifies only the right token', () => {
    const link = mediaLink(BASE, SECRET, 'med_1', 'image');
    const token = new URL(link).searchParams.get('t') as string;
    expect(mediaTokenMatches(SECRET, 'med_1', token)).toBe(true);
    expect(mediaTokenMatches(SECRET, 'med_2', token)).toBe(false);
    expect(mediaTokenMatches('other', 'med_1', token)).toBe(false);
  });

  it('finds every link in a reply once, in order, with its kind', () => {
    const a = mediaLink(BASE, SECRET, 'med_a', 'image');
    const b = mediaLink(BASE, SECRET, 'med_b', 'video');
    const found = mediaLinksIn(`Here you go:\n${a}\nand a clip\n${b}\n(${a})`, BASE);
    expect(found.map((m) => [m.id, m.kind])).toEqual([['med_a', 'image'], ['med_b', 'video']]);
    expect(found[0]?.url).toBe(a);
  });

  it('ignores links to anywhere else', () => {
    expect(mediaLinksIn('https://elsewhere.example/api/media/med_x?t=abc&k=image', BASE)).toEqual([]);
  });

  it('knows a line that is only a link', () => {
    const a = mediaLink(BASE, SECRET, 'med_a', 'video');
    expect(isMediaLine(`  ${a} `)?.kind).toBe('video');
    expect(isMediaLine(`see ${a}`)).toBeUndefined();
  });
});
