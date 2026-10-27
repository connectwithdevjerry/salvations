import { describe, expect, it } from 'vitest';
import { visitorKey } from './demo-voice';

describe('the voice demo', () => {
  it('counts a visitor by a hash of their first forwarded address, never the address', () => {
    const a = visitorKey(new Request('http://x', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }));
    const b = visitorKey(new Request('http://x', { headers: { 'x-forwarded-for': '203.0.113.7' } }));
    const c = visitorKey(new Request('http://x', { headers: { 'x-forwarded-for': '198.51.100.2' } }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('203.0.113.7');
  });
});
