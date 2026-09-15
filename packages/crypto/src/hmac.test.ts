import { describe, expect, it } from 'vitest';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, generateHmacSecret, sign, verify } from './hmac.js';

const SECRET = 'internal-secret';
const NOW = 1_789_000_000_000;
const headersOf = (h: Record<string, string>) => ({
  signature: h[SIGNATURE_HEADER] as string,
  timestamp: h[TIMESTAMP_HEADER] as string,
});

describe('internal request signing', () => {
  it('verifies a correctly signed request', () => {
    const body = JSON.stringify({ runId: 'run_1' });
    const headers = sign(SECRET, 'POST', '/api/internal/execute', body, NOW);
    expect(verify(SECRET, 'POST', '/api/internal/execute', body, headersOf(headers), { now: NOW }))
      .toEqual({ ok: true });
  });

  it('rejects a request with no signature — a session cookie must not reach this endpoint', () => {
    // The whole point: /api/internal/execute drives arbitrary runs, so being
    // logged in must not be sufficient to call it.
    const r = verify(SECRET, 'POST', '/api/internal/execute', '{}',
      { signature: null, timestamp: String(NOW) }, { now: NOW });
    expect(r).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects a signature made with a different secret', () => {
    const body = '{}';
    const headers = sign('other-secret', 'POST', '/p', body, NOW);
    expect(verify(SECRET, 'POST', '/p', body, headersOf(headers), { now: NOW }))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('binds the signature to the method, the path and the body', () => {
    const headers = sign(SECRET, 'POST', '/api/internal/execute', '{"runId":"run_1"}', NOW);
    const h = headersOf(headers);
    expect(verify(SECRET, 'GET', '/api/internal/execute', '{"runId":"run_1"}', h, { now: NOW }).ok).toBe(false);
    expect(verify(SECRET, 'POST', '/api/internal/sweep', '{"runId":"run_1"}', h, { now: NOW }).ok).toBe(false);
    expect(verify(SECRET, 'POST', '/api/internal/execute', '{"runId":"run_2"}', h, { now: NOW }).ok).toBe(false);
  });

  it('is not confusable by shifting a character between fields', () => {
    // Without explicit lengths in the canonical string, these two requests
    // would serialise identically and share a MAC.
    const a = sign(SECRET, 'POST', '/a/b', 'c', NOW);
    expect(verify(SECRET, 'POST', '/a', 'b/c', headersOf(a), { now: NOW }).ok).toBe(false);
  });

  it('rejects a replayed request outside the window', () => {
    const headers = sign(SECRET, 'POST', '/p', '{}', NOW);
    const later = NOW + 5 * 60_000;
    expect(verify(SECRET, 'POST', '/p', '{}', headersOf(headers), { now: later }))
      .toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a future timestamp as firmly as an old one', () => {
    const headers = sign(SECRET, 'POST', '/p', '{}', NOW + 5 * 60_000);
    expect(verify(SECRET, 'POST', '/p', '{}', headersOf(headers), { now: NOW }).ok).toBe(false);
  });

  it('accepts a request inside the window', () => {
    const headers = sign(SECRET, 'POST', '/p', '{}', NOW);
    expect(verify(SECRET, 'POST', '/p', '{}', headersOf(headers), { now: NOW + 30_000 }).ok).toBe(true);
  });

  it('rejects malformed signature material', () => {
    expect(verify(SECRET, 'POST', '/p', '{}',
      { signature: 'deadbeef', timestamp: String(NOW) }, { now: NOW }).reason)
      .toBe('malformed_signature');
    expect(verify(SECRET, 'POST', '/p', '{}',
      { signature: 'v1=abc', timestamp: 'not-a-number' }, { now: NOW }).reason)
      .toBe('malformed_signature');
    expect(verify(SECRET, 'POST', '/p', '{}',
      { signature: 'v1=abc', timestamp: null }, { now: NOW }).reason)
      .toBe('missing_timestamp');
  });

  it('generates a usable secret', () => {
    expect(Buffer.from(generateHmacSecret(), 'base64')).toHaveLength(32);
  });
});
