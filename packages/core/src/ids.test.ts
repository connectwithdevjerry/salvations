import { describe, expect, it } from 'vitest';
import { newId, uuidv7 } from './ids.js';

describe('uuidv7', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('emits a well-formed v7 uuid with the RFC 4122 variant', () => {
    expect(uuidv7()).toMatch(UUID_RE);
  });

  it('sorts lexicographically in time order — the reason ids double as a timeline', () => {
    const early = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_001_000);
    expect(early < later).toBe(true);
  });

  it('is unique across a tight loop at a single millisecond', () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(now)));
    expect(ids.size).toBe(5000);
  });

  it('prefixes ids for log triage without breaking ordering', () => {
    const a = newId('run', 1_700_000_000_000);
    const b = newId('run', 1_700_000_001_000);
    expect(a.startsWith('run_')).toBe(true);
    expect(a < b).toBe(true);
  });
});
