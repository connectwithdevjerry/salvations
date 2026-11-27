import { describe, expect, it } from 'vitest';
import { mustVerify } from './email-verification';

describe('confirming an address', () => {
  it('holds back an unconfirmed account wherever mail can be sent', () => {
    expect(mustVerify({ emailVerifiedAt: null }, true)).toBe(true);
    expect(mustVerify({}, true)).toBe(true);
  });

  it('lets a confirmed account through', () => {
    expect(mustVerify({ emailVerifiedAt: new Date() }, true)).toBe(false);
  });

  it('holds nobody back where no code could be sent', () => {
    expect(mustVerify({ emailVerifiedAt: null }, false)).toBe(false);
  });
});
