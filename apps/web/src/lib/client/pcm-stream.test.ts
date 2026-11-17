import { describe, expect, it } from 'vitest';
import { pcm16ToFloat32 } from './pcm-stream';

describe('raw speech', () => {
  it('reads little-endian 16-bit samples as floats', () => {
    const { samples, carry } = pcm16ToFloat32(new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]), undefined);
    expect(Array.from(samples)).toEqual([0, 32767 / 32768, -1]);
    expect(carry).toBeUndefined();
  });

  it('keeps a sample split across two pieces whole', () => {
    const first = pcm16ToFloat32(new Uint8Array([0x00, 0x40, 0x00]), undefined);
    expect(Array.from(first.samples)).toEqual([0.5]);
    expect(Array.from(first.carry ?? [])).toEqual([0x00]);
    const second = pcm16ToFloat32(new Uint8Array([0xc0]), first.carry);
    expect(Array.from(second.samples)).toEqual([-0.5]);
    expect(second.carry).toBeUndefined();
  });
});
