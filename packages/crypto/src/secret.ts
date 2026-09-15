/**
 * A secret value that resists accidental disclosure.
 *
 * Plaintext credentials leak most often by accident — a console.log during
 * debugging, a JSON.stringify of a config object, an error serialised into a
 * trace. This wrapper makes every one of those paths print a placeholder
 * instead, so reading the value requires explicitly calling `expose()`.
 */

const REDACTED = '[redacted]';

/** Node's util.inspect hook, declared without importing node:util into the type. */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class Secret {
  readonly #value: string;
  readonly #label: string;

  constructor(value: string, label = 'secret') {
    this.#value = value;
    this.#label = label;
  }

  /** The only way to read the value. Deliberately verbose at call sites. */
  expose(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  /** A non-reversible fingerprint, safe to log when correlating without exposing. */
  get hint(): string {
    if (this.#value.length <= 8) return `${this.#label}:****`;
    return `${this.#label}:****${this.#value.slice(-4)}`;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return `Secret(${this.#label}) ${REDACTED}`;
  }
}

export const isSecret = (v: unknown): v is Secret => v instanceof Secret;

/**
 * A secret with a lifetime.
 *
 * Resolved credentials should not sit in memory for the life of a process.
 * Once destroyed, `expose()` throws rather than returning a stale value — which
 * turns a lifetime bug into a loud failure instead of a silent reuse.
 */
export class EphemeralSecret {
  #value: string | undefined;
  readonly #label: string;
  readonly #expiresAt: number;

  constructor(value: string, ttlMs: number, label = 'secret') {
    this.#value = value;
    this.#label = label;
    this.#expiresAt = Date.now() + ttlMs;
  }

  expose(): string {
    if (this.#value === undefined) {
      throw new Error(`Secret "${this.#label}" was destroyed and cannot be read again.`);
    }
    if (Date.now() > this.#expiresAt) {
      this.destroy();
      throw new Error(`Secret "${this.#label}" expired. Resolve it again rather than caching it.`);
    }
    return this.#value;
  }

  destroy(): void {
    this.#value = undefined;
  }

  get destroyed(): boolean {
    return this.#value === undefined;
  }

  toString(): string { return REDACTED; }
  toJSON(): string { return REDACTED; }
  [INSPECT](): string { return `EphemeralSecret(${this.#label}) ${REDACTED}`; }
}
