import { describe, expect, it } from 'vitest';
import { nativeAliasMatches, nextAlias } from './native-alias';

describe('nextAlias', () => {
  it('gives the base itself when it is free', () => {
    expect(nextAlias('google_workspace', new Set())).toBe('google_workspace');
  });
  it('numbers the second account and on, skipping what is taken', () => {
    expect(nextAlias('google_workspace', new Set(['google_workspace']))).toBe('google_workspace_2');
    expect(nextAlias('google_workspace', new Set(['google_workspace', 'google_workspace_2']))).toBe('google_workspace_3');
    // A gap from a disconnected account is reused rather than counted past.
    expect(nextAlias('google_workspace', new Set(['google_workspace', 'google_workspace_3']))).toBe('google_workspace_2');
  });
});

describe('nativeAliasMatches', () => {
  it('recognises the app under any of its account aliases, and no other app', () => {
    expect(nativeAliasMatches('google_workspace', 'google_workspace')).toBe(true);
    expect(nativeAliasMatches('google_workspace_2', 'google_workspace')).toBe(true);
    expect(nativeAliasMatches('google_workspaces', 'google_workspace')).toBe(false);
    expect(nativeAliasMatches('gateway_2', 'google_workspace')).toBe(false);
  });
});
