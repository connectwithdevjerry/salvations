/**
 * Canonical JSON.
 *
 * Key order is not semantic, so hashing raw `JSON.stringify` output reports a
 * change every time something reserialises an identical object. A hash that
 * cries wolf is worse than no hash: it trains whoever reads it to click through.
 *
 * Two places depend on this being exact — the capability `definitionHash` that
 * invalidates approval, and the prompt-prefix fingerprint that decides whether a
 * cache hit was even possible.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * A short, stable digest of a canonical form.
 *
 * FNV-1a rather than SHA-256: this runs on every model call, the input is
 * already canonical, and nothing security-relevant depends on it — a collision
 * costs a misreported cache diagnostic. Where collision resistance against a
 * hostile party matters (the capability definition hash), a real digest is used
 * instead.
 */
export function fingerprint(value: unknown): string {
  const text = canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
