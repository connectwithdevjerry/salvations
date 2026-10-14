import { describe, expect, it } from 'vitest';
import { needsSweep, SWEEP_MARGIN_MS } from './google-workspace';

describe('needsSweep', () => {
  const now = 1_800_000_000_000;
  it('renews a token that lapses within the margin and has a refresh token', () => {
    expect(needsSweep({ access_token: 'a', refresh_token: 'r', expires_at: now + SWEEP_MARGIN_MS / 2 }, now)).toBe(true);
    expect(needsSweep({ access_token: 'a', refresh_token: 'r', expires_at: now - 1 }, now)).toBe(true);
  });
  it('leaves a token with time on it alone', () => {
    expect(needsSweep({ access_token: 'a', refresh_token: 'r', expires_at: now + SWEEP_MARGIN_MS + 1 }, now)).toBe(false);
  });
  it('cannot renew without a refresh token, so does not try', () => {
    expect(needsSweep({ access_token: 'a', expires_at: now - 1 }, now)).toBe(false);
  });
});
