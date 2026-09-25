import { describe, expect, it } from 'vitest';
import {
  MAX_TTL_MS, ScopedResponseCache, cacheKeyFor, clampTtl, isShareableAcrossUsers, parseCacheScope,
} from './cache';
import { scopeFor, scopeKeyString, userScope, workspaceScope } from './scope';

const WS = 'wks_1';
const BINDING = 'mcb_1';
const alice = userScope(WS, BINDING, 'usr_alice');
const bob = userScope(WS, BINDING, 'usr_bob');
const shared = workspaceScope(WS, BINDING);

describe('cacheScope is read fail-closed', () => {
  it('recognises the spec values', () => {
    expect(parseCacheScope('public')).toBe('public');
    expect(parseCacheScope('private')).toBe('private');
  });

  it('treats absent or unrecognised as not shareable', () => {
    // A missing field is an older server; an unknown one is a newer spec or a
    // broken server. Neither entitles us to assume sharing is safe.
    for (const raw of [undefined, null, '', 'shared', 'user', 'session', 42, {}]) {
      expect(parseCacheScope(raw)).toBe('unknown');
      expect(isShareableAcrossUsers(parseCacheScope(raw))).toBe(false);
    }
  });

  it('shares only on an explicit public', () => {
    expect(isShareableAcrossUsers('public')).toBe(true);
    expect(isShareableAcrossUsers('private')).toBe(false);
    expect(isShareableAcrossUsers('unknown')).toBe(false);
  });
});

describe('cache keys', () => {
  it('files a shared response under the workspace, so the next user hits it', () => {
    expect(cacheKeyFor(alice, 'tools/list', 'public'))
      .toBe(cacheKeyFor(bob, 'tools/list', 'public'));
  });

  it('keeps a per-user response private to that user', () => {
    expect(cacheKeyFor(alice, 'tools/list', 'private'))
      .not.toBe(cacheKeyFor(bob, 'tools/list', 'private'));
  });

  it('keeps an unknown-scope response private', () => {
    expect(cacheKeyFor(alice, 'tools/list', 'unknown'))
      .not.toBe(cacheKeyFor(bob, 'tools/list', 'unknown'));
  });

  it('never collides across bindings or workspaces', () => {
    const other = userScope('wks_2', BINDING, 'usr_alice');
    expect(cacheKeyFor(alice, 'tools/list', 'private')).not.toBe(cacheKeyFor(other, 'tools/list', 'private'));
    expect(cacheKeyFor(alice, 'tools/list', 'private'))
      .not.toBe(cacheKeyFor(userScope(WS, 'mcb_2', 'usr_alice'), 'tools/list', 'private'));
  });

  it('separates methods', () => {
    expect(cacheKeyFor(alice, 'tools/list', 'private')).not.toBe(cacheKeyFor(alice, 'prompts/list', 'private'));
  });
});

describe('TTL handling', () => {
  it('refuses to cache without a positive TTL', () => {
    for (const ttl of [undefined, null, 0, -1, Number.NaN, 'soon']) {
      expect(clampTtl(ttl)).toBe(0);
    }
  });

  it('caps a server-supplied TTL', () => {
    // A hostile or buggy ttlMs must not pin a stale tool surface in place.
    expect(clampTtl(365 * 24 * 3600 * 1000)).toBe(MAX_TTL_MS);
    expect(clampTtl(1000)).toBe(1000);
  });
});

describe('ScopedResponseCache — no cross-user leakage (R4)', () => {
  it('does not serve one user a private response fetched by another', () => {
    // The leak this exists to prevent.
    const cache = new ScopedResponseCache();
    cache.set(alice, 'tools/list', { tools: ['alice-only'] }, 60_000, 'private');
    expect(cache.get(bob, 'tools/list')).toBeUndefined();
    expect(cache.get(alice, 'tools/list')).toEqual({ tools: ['alice-only'] });
  });

  it('refuses to share when the server said nothing about scope', () => {
    const cache = new ScopedResponseCache();
    cache.set(alice, 'tools/list', { tools: ['x'] }, 60_000, undefined);
    expect(cache.get(bob, 'tools/list')).toBeUndefined();
  });

  it('shares only when the server explicitly permits it', () => {
    const cache = new ScopedResponseCache();
    cache.set(alice, 'tools/list', { tools: ['public'] }, 60_000, 'public');
    expect(cache.get(bob, 'tools/list')).toEqual({ tools: ['public'] });
  });

  it('does not leak between workspaces even for a shared response', () => {
    const cache = new ScopedResponseCache();
    cache.set(alice, 'tools/list', { tools: ['x'] }, 60_000, 'public');
    expect(cache.get(userScope('wks_2', BINDING, 'usr_alice'), 'tools/list')).toBeUndefined();
  });

  it('stores nothing when the server supplied no TTL', () => {
    const cache = new ScopedResponseCache();
    cache.set(alice, 'tools/list', { tools: ['x'] }, undefined, 'shared');
    expect(cache.size).toBe(0);
  });

  it('expires entries', () => {
    let now = 1_000;
    const cache = new ScopedResponseCache({ now: () => now });
    cache.set(shared, 'tools/list', { tools: ['x'] }, 5_000, 'public');
    now = 5_999;
    expect(cache.get(shared, 'tools/list')).toBeDefined();
    now = 6_001;
    expect(cache.get(shared, 'tools/list')).toBeUndefined();
  });

  it('drops every scope for a binding on invalidation', () => {
    // Reconfiguration or revocation must not leave a stale tool surface.
    const cache = new ScopedResponseCache();
    cache.set(alice, 'tools/list', { a: 1 }, 60_000, 'private');
    cache.set(bob, 'tools/list', { b: 1 }, 60_000, 'private');
    cache.set(shared, 'prompts/list', { c: 1 }, 60_000, 'public');

    expect(cache.invalidateBinding(WS, BINDING)).toBe(3);
    expect(cache.get(alice, 'tools/list')).toBeUndefined();
    expect(cache.get(bob, 'tools/list')).toBeUndefined();
  });

  it('bounds its own size', () => {
    const cache = new ScopedResponseCache({ maxEntries: 10 });
    for (let i = 0; i < 50; i++) {
      cache.set(userScope(WS, `mcb_${i}`, 'u'), 'tools/list', { i }, 60_000, 'private');
    }
    expect(cache.size).toBeLessThanOrEqual(10);
  });
});

describe('scope selection', () => {
  it('uses a workspace scope when the binding is not per-user', () => {
    expect(scopeFor(WS, BINDING, false, undefined).kind).toBe('workspace');
  });

  it('uses a user scope when the binding is per-user', () => {
    const scope = scopeFor(WS, BINDING, true, 'usr_alice');
    expect(scope.kind).toBe('user');
    expect(scopeKeyString(scope)).toContain('usr_alice');
  });

  it('refuses to fall back to a workspace scope when a user is required', () => {
    // Falling back would let one user act with another's tokens.
    expect(() => scopeFor(WS, BINDING, true, undefined)).toThrow(/per-user authentication/);
  });
});
