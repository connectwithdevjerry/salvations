/**
 * The driver hands binData fields back as bson `Binary` objects, not as the
 * Uint8Array that was written. `Buffer.from(binary)` on one of those yields an
 * EMPTY buffer — `Binary.length` is a method, so Node treats it as a non-array
 * — and every envelope-encrypted value then fails as "truncated". Everything
 * that reads ciphertext, an IV, an auth tag or a wrapped DEK goes through here.
 */
export const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value !== null && typeof value === 'object') {
    const inner = (value as { buffer?: unknown }).buffer;
    if (inner instanceof Uint8Array) return inner;
    if (inner instanceof ArrayBuffer) return new Uint8Array(inner);
  }
  throw new TypeError('Expected binary data from the database.');
};
