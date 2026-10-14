import { describe, expect, it } from 'vitest';
import { hashLinkCode, offeredLinkCode } from './chat-link';

describe('a link code in a message', () => {
  it('is the whole message, with or without "link" in front, in any case', () => {
    expect(offeredLinkCode('ABCD2345')).toBe('ABCD2345');
    expect(offeredLinkCode('  link abcd2345 ')).toBe('ABCD2345');
    expect(offeredLinkCode('Link ABCD2345')).toBe('ABCD2345');
  });
  it('is not a word inside a sentence, and not a code with letters the alphabet leaves out', () => {
    expect(offeredLinkCode('please link ABCD2345 now')).toBeUndefined();
    expect(offeredLinkCode('tomorrow')).toBeUndefined();
    expect(offeredLinkCode('ABCD0OIL')).toBeUndefined();
  });
});

describe('the stored hash', () => {
  it('is the same for the same code however it was typed', () => {
    expect(hashLinkCode('abcd2345 ')).toBe(hashLinkCode('ABCD2345'));
    expect(hashLinkCode('ABCD2345')).not.toBe(hashLinkCode('ABCD2346'));
  });
});
