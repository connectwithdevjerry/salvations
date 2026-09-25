import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashPassword, needsRehash, verifyPassword } from './password';

describe('hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
  });

  it('produces a different hash every time for the same password', async () => {
    // A per-password salt is what stops one rainbow table covering every user,
    // and what stops two people with the same password being visibly equal.
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('records its parameters in the hash', async () => {
    // Raising the cost later must not invalidate every existing password, and
    // a hash that does not say how it was made cannot be verified afterwards.
    const hash = await hashPassword('x');
    const [scheme, n, r, p, salt, digest] = hash.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(32_768);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(Buffer.from(salt as string, 'base64url')).toHaveLength(16);
    expect(Buffer.from(digest as string, 'base64url')).toHaveLength(32);
  });

  it('normalises unicode, so the same typed password always verifies', async () => {
    // é can be one code point or two. Without normalisation a password typed on
    // one keyboard fails to verify when typed on another.
    const composed = 'passwordé';
    const decomposed = 'passwordé'.normalize('NFD');
    expect(composed).not.toBe(decomposed);
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
  });

  it('handles a very long password without truncating it', async () => {
    const long = 'p'.repeat(4_000);
    const hash = await hashPassword(long);
    expect(await verifyPassword(long, hash)).toBe(true);
    expect(await verifyPassword(`${long.slice(0, 3_999)}q`, hash)).toBe(false);
  });
});

describe('malformed input is never an oracle', () => {
  it('returns false rather than throwing on a corrupt hash', async () => {
    // A corrupt row must not be distinguishable from a wrong password.
    for (const bad of [
      '', 'not-a-hash', 'scrypt$', 'scrypt$1$2$3$4', 'bcrypt$1$8$1$aaaa$bbbb',
      'scrypt$notanumber$8$1$aaaa$bbbb', 'scrypt$32768$8$1$$', 'scrypt$32768$8$1$aaaa$',
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('refuses parameters that would exhaust memory', async () => {
    // Otherwise a hostile row turns every sign-in attempt into a denial of
    // service against ourselves.
    const hostile = `scrypt$${2 ** 24}$32$16$aaaa$bbbb`;
    const started = Date.now();
    expect(await verifyPassword('anything', hostile)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('timing', () => {
  it('offers a dummy hash so an unknown email costs the same as a known one', async () => {
    // Without it, response time alone tells an attacker which addresses exist.
    expect(DUMMY_HASH).toMatch(/^scrypt\$/);
    expect(await verifyPassword('anything at all', DUMMY_HASH)).toBe(false);
  });
});

describe('rehashing', () => {
  it('flags a hash made with weaker parameters', () => {
    expect(needsRehash('scrypt$16384$8$1$aaaa$bbbb')).toBe(true);
    expect(needsRehash('scrypt$32768$8$1$aaaa$bbbb')).toBe(false);
  });

  it('flags anything it does not recognise', () => {
    expect(needsRehash('bcrypt$2b$12$whatever')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});
