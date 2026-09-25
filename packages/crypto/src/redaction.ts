/**
 * Redaction, applied at WRITE time rather than at display time.
 *
 * Tool arguments, run steps and audit metadata all persist whatever an agent
 * passed around, and some of that is secret. Redacting when rendering leaves
 * the plaintext in the database and in every log shipper that already read it.
 *
 * Two independent signals, because either alone misses real cases:
 *   - the KEY name (catches a low-entropy secret like a password)
 *   - the VALUE shape (catches a secret under an innocuous key such as "q")
 */

export const REDACTED = '[redacted]';

/** Key names that mean "secret" regardless of what the value looks like. */
const SENSITIVE_KEY = new RegExp(
  [
    'pass(word|wd|phrase)?',
    'secret',
    'token',
    'api[-_]?key',
    '(^|[-_])key$',
    'credential',
    'authorization',
    'auth[-_]?header',
    'cookie',
    'session[-_]?id',
    'private[-_]?key',
    'client[-_]?secret',
    'refresh[-_]?token',
    'access[-_]?token',
    'bearer',
    'signature',
    'salt',
    'otp',
    'mfa',
    'pin$',
  ].join('|'),
  'i',
);

/** Recognisable credential shapes, worth redacting wherever they appear. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,              // provider-style API keys
  /\bsk_(live|test)_[A-Za-z0-9_-]{12,}/,  // our own key format
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,         // forge tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,       // chat platform tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,   // PEM material
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWTs
  /\bmongodb(\+srv)?:\/\/[^:\s]+:[^@\s]+@/, // connection strings with a password
  /\b[a-z]+:\/\/[^:\s/]+:[^@\s]+@/,       // any URL carrying credentials
];

/** Shapes that look high-entropy but are safe and useful to keep in a log. */
const KNOWN_SAFE: readonly RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[a-z]{3,4}_[0-9a-f]{8}-[0-9a-f]{4}-/i,                          // our prefixed ids
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/,                                  // iso timestamps
  /^sha256:[0-9a-f]{64}$/i,                                         // definition hashes
];

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const ENTROPY_MIN_LENGTH = 25;
const ENTROPY_THRESHOLD = 3.5;

export function looksSecret(value: string): boolean {
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  if (value.length < ENTROPY_MIN_LENGTH) return false;
  for (const safe of KNOWN_SAFE) {
    if (safe.test(value)) return false;
  }
  // Prose is long but low-entropy; a packed random token is both long and dense.
  if (/\s/.test(value)) return false;
  return shannonEntropy(value) >= ENTROPY_THRESHOLD;
}

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

export interface RedactOptions {
  /** Extra key names to treat as sensitive, e.g. from a tool's input schema. */
  readonly sensitiveKeys?: readonly string[];
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
}

/**
 * Deep-redacts a value, preserving structure so the result stays diagnosable.
 *
 * Cycles are replaced rather than throwing: this runs on the write path, and a
 * crash while persisting an audit record would lose the record.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const extra = new Set((options.sensitiveKeys ?? []).map((k) => k.toLowerCase()));
  const maxDepth = options.maxDepth ?? 8;
  const maxStringLength = options.maxStringLength ?? 4096;
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number, keyHint: string | undefined): unknown => {
    if (node === null || node === undefined) return node;

    if (typeof node === 'string') {
      if (keyHint !== undefined && (isSensitiveKey(keyHint) || extra.has(keyHint.toLowerCase()))) {
        return REDACTED;
      }
      if (looksSecret(node)) return REDACTED;
      return node.length > maxStringLength
        ? `${node.slice(0, maxStringLength)}…[truncated ${node.length - maxStringLength}]`
        : node;
    }

    if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'bigint') {
      // A sensitive key holding a non-string still holds a secret (e.g. a PIN).
      if (keyHint !== undefined && (isSensitiveKey(keyHint) || extra.has(keyHint.toLowerCase()))) {
        return REDACTED;
      }
      return typeof node === 'bigint' ? node.toString() : node;
    }

    if (typeof node === 'function' || typeof node === 'symbol') return '[unserialisable]';

    if (node instanceof Date) return node.toISOString();
    if (node instanceof Error) return { name: node.name, message: REDACTED };
    if (node instanceof Uint8Array) return `[binary ${node.length} bytes]`;

    if (depth >= maxDepth) return '[depth limit]';

    if (typeof node === 'object') {
      if (seen.has(node)) return '[circular]';
      seen.add(node);

      if (Array.isArray(node)) {
        return node.map((item) => walk(item, depth + 1, keyHint));
      }

      // Anything that hid its own value (Secret, EphemeralSecret) stays hidden.
      const maybeJson = (node as { toJSON?: () => unknown }).toJSON;
      if (typeof maybeJson === 'function') {
        const produced = maybeJson.call(node);
        if (produced === REDACTED) return REDACTED;
        return walk(produced, depth + 1, keyHint);
      }

      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, depth + 1, k);
      }
      return out;
    }

    return node;
  };

  return walk(value, 0, undefined);
}

/**
 * Collects the property names a tool's JSON Schema marks sensitive, so
 * redaction is schema-driven where a schema exists and heuristic where it
 * does not.
 */
export function sensitiveKeysFromSchema(schema: unknown, depth = 0): string[] {
  if (depth > 8 || schema === null || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const found: string[] = [];

  const properties = node['properties'];
  if (properties !== null && typeof properties === 'object') {
    for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
      if (sub !== null && typeof sub === 'object') {
        const subNode = sub as Record<string, unknown>;
        const format = subNode['format'];
        const writeOnly = subNode['writeOnly'];
        if (format === 'password' || writeOnly === true || isSensitiveKey(key)) {
          found.push(key);
        }
        found.push(...sensitiveKeysFromSchema(sub, depth + 1));
      }
    }
  }
  for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
    const branches = node[combinator];
    if (Array.isArray(branches)) {
      for (const branch of branches) found.push(...sensitiveKeysFromSchema(branch, depth + 1));
    }
  }
  return [...new Set(found)];
}
