/**
 * Baseline argument redaction.
 *
 * Tool arguments are written to the run timeline and the audit log, and a model
 * routinely passes a token, a password or a key as a tool argument because the
 * tool asked for one. Storing that verbatim turns an audit trail into a
 * credential store.
 *
 * This is the FLOOR, not the ceiling. It matches on key names only, which is
 * cheap, has no dependencies, and can live in the pure domain — so a path that
 * forgot to inject the richer redactor still does not write a secret it was
 * handed by name. The entropy-based detector in `@salvations/crypto` is layered
 * on top at the composition root and catches the values this one cannot.
 */
export const REDACTED = '[redacted]';

/**
 * Key names whose value is never worth keeping.
 *
 * Matched as TOKENS, not substrings. A substring rule looks simpler and is
 * wrong in both directions: `auth` swallows `authorName`, `pin` swallows
 * `shipping`, and redacting a useful diagnostic field is a quiet loss nobody
 * notices until they need it. Splitting the key first also means `apiKey`,
 * `api_key` and `x-api-key` all reduce to the same tokens, so the list does not
 * have to enumerate every spelling.
 */
const SENSITIVE_TOKENS: ReadonlySet<string> = new Set([
  'password', 'passwd', 'passphrase', 'pass',
  'secret', 'token', 'credential', 'credentials',
  'authorization', 'cookie', 'session', 'bearer', 'jwt', 'signature',
  'otp', 'pin', 'cvv', 'cvc', 'ssn',
]);

/**
 * Multi-token names, where a single token would be far too broad.
 *
 * `key` alone would redact `keyword`, `keyName` and `sortKey` — all of them
 * ordinary arguments — so it is matched only in a pair. `apiKey` and
 * `privateKey` are unambiguous.
 */
const SENSITIVE_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'], ['private', 'key'], ['access', 'key'], ['secret', 'key'],
  ['client', 'secret'], ['access', 'token'], ['refresh', 'token'], ['id', 'token'],
];

/** Splits `x-api-key`, `apiKey` and `API_KEY` into the same lowercase tokens. */
export function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+|\s+/)
    .filter((part) => part !== '')
    .map((part) => part.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  const tokens = keyTokens(key);
  if (tokens.some((token) => SENSITIVE_TOKENS.has(token))) return true;

  for (const [first, second] of SENSITIVE_PAIRS) {
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (tokens[i] === first && tokens[i + 1] === second) return true;
    }
  }
  return false;
}

export interface RedactArgumentOptions {
  /** Extra key names, e.g. drawn from a tool's own input schema. */
  readonly sensitiveKeys?: readonly string[];
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
}

/**
 * Deep-redacts a value, preserving its structure.
 *
 * Structure is kept so the record stays diagnosable: knowing a call passed
 * `{ query: 'invoices', token: [redacted] }` tells a reviewer far more than a
 * record saying only that arguments were present. Cycles are replaced rather
 * than thrown on — this runs on the write path, and a crash while persisting an
 * audit record loses the record.
 */
export function redactDeep(value: unknown, options: RedactArgumentOptions = {}): unknown {
  const extra = new Set((options.sensitiveKeys ?? []).map((k) => k.toLowerCase()));
  const maxDepth = options.maxDepth ?? 8;
  const maxStringLength = options.maxStringLength ?? 2_000;
  const seen = new WeakSet<object>();

  const sensitive = (key: string | undefined): boolean =>
    key !== undefined && (isSensitiveKey(key) || extra.has(key.toLowerCase()));

  const walk = (node: unknown, depth: number, key: string | undefined): unknown => {
    if (node === null || node === undefined) return node;
    if (sensitive(key)) return REDACTED;

    if (typeof node === 'string') {
      return node.length > maxStringLength
        ? `${node.slice(0, maxStringLength)}…[truncated ${node.length - maxStringLength}]`
        : node;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return node;
    if (typeof node === 'bigint') return node.toString();
    if (typeof node !== 'object') return `[${typeof node}]`;

    if (depth >= maxDepth) return '[depth limit]';
    if (seen.has(node)) return '[circular]';
    seen.add(node);

    if (Array.isArray(node)) {
      return node.slice(0, 100).map((item) => walk(item, depth + 1, key));
    }

    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(node as Record<string, unknown>)) {
      out[childKey] = walk(childValue, depth + 1, childKey);
    }
    return out;
  };

  return walk(value, 0, undefined);
}
