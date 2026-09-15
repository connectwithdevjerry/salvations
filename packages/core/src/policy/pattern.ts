/** Glob matching for capability patterns. `*` matches any run of characters. */

const escapeRegex = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  const re = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
  // Patterns come from operator-authored policy, a bounded set; cap anyway.
  if (cache.size < 1000) cache.set(pattern, re);
  return re;
}

export const globMatches = (pattern: string, value: string): boolean =>
  pattern === '*' || globToRegExp(pattern).test(value);

/**
 * How specific a pattern is. Exact beats partial beats wildcard.
 * Used to rank competing policy rules.
 */
export function patternSpecificity(pattern: string): 0 | 1 | 2 {
  if (pattern === '*') return 0;
  return pattern.includes('*') ? 1 : 2;
}
