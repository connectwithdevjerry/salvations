/**
 * Structured logging.
 *
 * One JSON object per line, because every log aggregator can parse that and
 * none of them can reliably parse prose. A message like
 * `run run_123 failed after 4 steps` is unsearchable across a million lines;
 * `{"msg":"run failed","runId":"run_123","steps":4}` is a query.
 *
 * Redaction is applied HERE, on the way out, not by callers. A caller that has
 * to remember is a caller that will forget once, and the forgotten one writes a
 * token into a log that is shipped to a third party and retained for a year.
 */
import { redactDeep, type LogLevel, type Logger } from '@salvations/core';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10, info: 20, warn: 30, error: 40,
});

export interface LogRecord {
  readonly level: LogLevel;
  readonly msg: string;
  readonly time: string;
  readonly [field: string]: unknown;
}

/** Where a line goes. Injected so tests read records instead of parsing stdout. */
export type LogSink = (record: LogRecord) => void;

export const consoleSink: LogSink = (record) => {
  // One line, on stdout even for errors: a platform that splits streams
  // interleaves them unpredictably, and an error in the middle of a request is
  // useless without the lines around it.
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly now?: () => Date;
  /** Field names to redact beyond the defaults — a tool's own schema may add some. */
  readonly sensitiveKeys?: readonly string[];
}

/**
 * Fields that are never useful and frequently dangerous.
 *
 * Redaction by key name catches the obvious cases; these are the ones people
 * add to a log line on purpose while debugging and then forget to remove.
 */
const ALWAYS_REDACT = [
  'authorization', 'cookie', 'setCookie', 'refreshToken', 'accessToken',
  'idToken', 'passwordHash', 'plaintext', 'apiKey', 'clientSecret',
] as const;

class StructuredLogger implements Logger {
  readonly #bound: Record<string, unknown>;
  readonly #options: Required<Omit<LoggerOptions, 'sensitiveKeys'>> & {
    sensitiveKeys: readonly string[];
  };

  constructor(bound: Record<string, unknown>, options: LoggerOptions = {}) {
    this.#bound = bound;
    this.#options = {
      level: options.level ?? 'info',
      sink: options.sink ?? consoleSink,
      now: options.now ?? (() => new Date()),
      sensitiveKeys: [...ALWAYS_REDACT, ...(options.sensitiveKeys ?? [])],
    };
  }

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#options.level]) return;

    const merged = { ...this.#bound, ...fields };
    const safe = redactDeep(merged, {
      sensitiveKeys: this.#options.sensitiveKeys,
      // A log line is a line. A 2000-character field is a log nobody reads and
      // a bill somebody pays.
      maxStringLength: 512,
      maxDepth: 5,
    }) as Record<string, unknown>;

    this.#options.sink({
      ...safe,
      // Last, so a bound field called `level` or `msg` cannot displace the real
      // one and make a line unfilterable.
      level,
      msg: message,
      time: this.#options.now().toISOString(),
    });
  }

  /**
   * A logger carrying context.
   *
   * The point is that a run id appears on every line from that run without any
   * call site passing it, which is what makes a log searchable after the fact.
   */
  child(fields: Record<string, unknown>): Logger {
    return new StructuredLogger({ ...this.#bound, ...fields }, this.#options);
  }
}

export const createLogger = (
  bound: Record<string, unknown> = {},
  options: LoggerOptions = {},
): Logger => new StructuredLogger(bound, options);

/** Discards everything. The default in tests, so output stays readable. */
export const NO_LOGGER: Logger = {
  log: () => undefined,
  child: () => NO_LOGGER,
};
