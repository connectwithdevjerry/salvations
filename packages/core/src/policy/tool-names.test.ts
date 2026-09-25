import { describe, expect, it } from 'vitest';
import { buildToolNameMap, canonicalNameOf, wireNameOf } from './tool-names';

const RULES = { namePattern: '^[a-zA-Z0-9_-]{1,64}$', maxNameLength: 64 };
const legal = (name: string) => new RegExp(RULES.namePattern).test(name);

describe('tool name normalisation', () => {
  it('leaves a short legal name untouched', () => {
    const map = buildToolNameMap(['linear__create_issue'], RULES);
    expect(wireNameOf(map, 'linear__create_issue')).toBe('linear__create_issue');
  });

  it('produces legal names for anything over the limit', () => {
    const long = `${'a'.repeat(60)}__${'b'.repeat(60)}`;
    const map = buildToolNameMap([long], RULES);
    const wire = wireNameOf(map, long);
    expect(wire.length).toBeLessThanOrEqual(64);
    expect(legal(wire)).toBe(true);
  });

  it('never collides two tools that share a truncated prefix', () => {
    // The dangerous case: the model calls one tool and the gateway resolves
    // the other. Truncation alone would do exactly that.
    const prefix = 'a'.repeat(70);
    const a = `${prefix}__alpha`;
    const b = `${prefix}__beta`;
    const map = buildToolNameMap([a, b], RULES);
    expect(wireNameOf(map, a)).not.toBe(wireNameOf(map, b));
  });

  it('round-trips back to the canonical name', () => {
    const names = ['linear__create_issue', `${'x'.repeat(70)}__thing`, 'a.b__c d'];
    const map = buildToolNameMap(names, RULES);
    for (const canonical of names) {
      expect(canonicalNameOf(map, wireNameOf(map, canonical))).toBe(canonical);
    }
  });

  it('replaces illegal characters', () => {
    const map = buildToolNameMap(['my.server__do thing!'], RULES);
    expect(legal(wireNameOf(map, 'my.server__do thing!'))).toBe(true);
  });

  it('disambiguates names that sanitise identically', () => {
    // "a.b" and "a b" both sanitise to "a_b" — distinct tools must stay distinct.
    const map = buildToolNameMap(['x__a.b', 'x__a b'], RULES);
    expect(wireNameOf(map, 'x__a.b')).not.toBe(wireNameOf(map, 'x__a b'));
  });

  it('respects a stricter vendor limit', () => {
    const strict = { namePattern: '^[a-z0-9_]{1,20}$', maxNameLength: 20 };
    const map = buildToolNameMap(['binding__some_long_tool_name'], strict);
    expect(wireNameOf(map, 'binding__some_long_tool_name').length).toBeLessThanOrEqual(20);
  });

  it('ensures a name starts with a letter or underscore, never a digit', () => {
    // At least one vendor rejects a leading digit outright.
    expect(wireNameOf(buildToolNameMap(['__leading'], RULES), '__leading')).toMatch(/^[a-zA-Z_]/);
    expect(wireNameOf(buildToolNameMap(['9lives__go'], RULES), '9lives__go')).toMatch(/^[a-zA-Z_]/);
  });

  it('satisfies a vendor alphabet that forbids hyphens', () => {
    // Hyphens are legal for some vendors and rejected by others, so nothing
    // depends on them; the reverse map restores the original either way.
    const strict = { namePattern: '^[a-zA-Z_][a-zA-Z0-9_]{0,62}$', maxNameLength: 63 };
    const canonical = 'a-very-long-binding-alias__a_tool_name';
    const map = buildToolNameMap([canonical], strict);
    const wire = wireNameOf(map, canonical);
    expect(new RegExp(strict.namePattern).test(wire)).toBe(true);
    expect(canonicalNameOf(map, wire)).toBe(canonical);
  });

  it('fails loudly rather than emitting a name the provider will reject', () => {
    const impossible = { namePattern: '^[0-9]+$', maxNameLength: 10 };
    expect(() => buildToolNameMap(['tool__name'], impossible)).toThrow(/does not satisfy/);
  });

  it('surfaces an unknown wire name rather than mapping it to something else', () => {
    const map = buildToolNameMap(['known__tool'], RULES);
    expect(canonicalNameOf(map, 'hallucinated_tool')).toBe('hallucinated_tool');
  });

  it('is deterministic across builds', () => {
    const names = [`${'z'.repeat(70)}__one`, `${'z'.repeat(70)}__two`];
    expect(buildToolNameMap(names, RULES).toWire).toEqual(buildToolNameMap(names, RULES).toWire);
  });
});
