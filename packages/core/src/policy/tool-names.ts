/**
 * Provider-legal tool naming.
 *
 * Canonical names are `<bindingAlias>__<tool>`, which is unique per workspace by
 * construction but can exceed a vendor's length limit or use characters it
 * rejects. Vendors differ, so the rules come from ModelCapabilities rather than
 * from a per-vendor branch.
 *
 * Truncation alone would let two distinct tools collapse onto one name — the
 * model would call one and get the other. A hash of the FULL canonical name is
 * appended so that cannot happen, and a reverse map restores the original.
 */

const HASH_LENGTH = 6;

/** Small, stable, non-cryptographic hash — collision resistance here is about
 *  distinguishing a handful of tools, not resisting an adversary. */
function shortHash(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, HASH_LENGTH).padEnd(HASH_LENGTH, '0');
}

export interface ToolNameRules {
  readonly namePattern: string;
  readonly maxNameLength: number;
}

/**
 * Maps canonical names to provider-legal ones.
 *
 * Returns both directions: the model answers with the wire name, and the
 * gateway needs the canonical name back to resolve a binding.
 */
export interface ToolNameMap {
  readonly toWire: ReadonlyMap<string, string>;
  readonly toCanonical: ReadonlyMap<string, string>;
}

/**
 * Reduces a name to the intersection of every vendor's accepted alphabet.
 *
 * Deliberately conservative: letters, digits and underscore, starting with a
 * letter or underscore. Hyphens are legal for some vendors and rejected by
 * others, and a leading digit is rejected by at least one, so nothing depends
 * on either. The reverse map restores the original, so the loss costs nothing.
 */
const sanitise = (name: string): string => {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_{3,}/g, '__');
  return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `t${cleaned}`;
};

/**
 * A wire name that still fails the vendor's own pattern is a bug in this
 * function, not a recoverable condition: sending it produces a request the API
 * rejects, far from the cause. Fail here instead.
 */
function assertLegal(wire: string, canonical: string, rules: ToolNameRules): void {
  if (!new RegExp(rules.namePattern).test(wire)) {
    throw new Error(
      `Normalised tool name "${wire}" (from "${canonical}") does not satisfy the provider ` +
        `pattern ${rules.namePattern}. Widen sanitise() rather than letting the request fail.`,
    );
  }
}

export function buildToolNameMap(
  canonicalNames: readonly string[],
  rules: ToolNameRules,
): ToolNameMap {
  const toWire = new Map<string, string>();
  const toCanonical = new Map<string, string>();

  for (const canonical of canonicalNames) {
    let wire = sanitise(canonical);

    if (wire.length > rules.maxNameLength) {
      const suffix = `_${shortHash(canonical)}`;
      wire = wire.slice(0, Math.max(1, rules.maxNameLength - suffix.length)) + suffix;
    }

    // Two different canonical names can still sanitise to the same wire name
    // (different illegal characters, same replacement). Disambiguate rather
    // than let the model call the wrong tool.
    if (toCanonical.has(wire) && toCanonical.get(wire) !== canonical) {
      const suffix = `_${shortHash(canonical)}`;
      wire = wire.slice(0, Math.max(1, rules.maxNameLength - suffix.length)) + suffix;
    }

    assertLegal(wire, canonical, rules);
    toWire.set(canonical, wire);
    toCanonical.set(wire, canonical);
  }

  return { toWire, toCanonical };
}

/** Falls back to the wire name when unknown, so an unexpected tool surfaces as
 *  a resolution failure rather than silently becoming a different tool. */
export const canonicalNameOf = (map: ToolNameMap, wireName: string): string =>
  map.toCanonical.get(wireName) ?? wireName;

export const wireNameOf = (map: ToolNameMap, canonical: string): string =>
  map.toWire.get(canonical) ?? canonical;
