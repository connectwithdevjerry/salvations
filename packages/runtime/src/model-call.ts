/**
 * One model call.
 *
 * Consumes a provider's event stream, republishes it to the run's event bus so
 * a browser can tail it without holding a connection to the executing function,
 * and folds it into a single result the rest of the step can use.
 *
 * Two hard rules live here:
 *
 * 1. A stream that ends without a `finish` event is an ERROR. Treating a
 *    truncated stream as `end_turn` is how an agent platform produces
 *    confidently incomplete answers with no trace of what went wrong.
 *
 * 2. Once content has reached the user, the attempt is COMMITTED. Retrying
 *    after that would replay text the user has already read, and there is no
 *    honest way to unsay it on an append-only event log.
 */
import {
  addUsage, emptyUsage,
  type ContentBlock, type FinishReason, type GenerationRequest, type ProviderError,
  type RunEventType, type Usage,
} from '@salvations/core';
import type { AgentProvider } from '@salvations/core';

export interface ModelAttempt {
  readonly provider: AgentProvider;
  /**
   * Assembled for THIS model.
   *
   * A fallback is a different model, and a prompt carries model-bound reasoning
   * artifacts, so each attempt brings its own request rather than reusing one.
   */
  readonly request: GenerationRequest;
  readonly modelId: string;
  readonly label: 'primary' | 'fallback';
}

/** Narrow publishing port, so the runtime never holds the bus itself. */
export type PublishEvent = (type: RunEventType, payload: unknown) => Promise<void>;

export interface ModelCallOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly publish?: PublishEvent;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export interface ModelCallResult {
  readonly content: readonly ContentBlock[];
  readonly providerArtifacts?: Readonly<Record<string, unknown>>;
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  readonly attempts: number;
  readonly usedFallback: boolean;
  readonly latencyMs: number;
}

export class ModelCallError extends Error {
  readonly providerError: ProviderError;
  readonly attempts: number;
  readonly streamed: boolean;

  constructor(providerError: ProviderError, attempts: number, streamed: boolean) {
    super(providerError.message);
    this.name = 'ModelCallError';
    this.providerError = providerError;
    this.attempts = attempts;
    this.streamed = streamed;
  }
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
} as const;

/**
 * Full jitter.
 *
 * Equal-spaced retries from many runs converge on the same instants and
 * reproduce the overload they are backing off from.
 */
export function backoffMs(
  attempt: number,
  options: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return Math.floor(options.random() * ceiling);
}

const asProviderError = (error: unknown): ProviderError =>
  ({
    kind: 'transport',
    message: error instanceof Error ? error.message : String(error),
    // A thrown exception is not a vendor signal; nothing here says it is safe
    // to repeat, and a tool-bearing request must not be repeated on a guess.
    retryable: false,
    providerRaw: error,
  });

interface StreamOutcome {
  readonly result?: ModelCallResult;
  readonly error?: ProviderError;
  /** Whether anything reached the user before this outcome. */
  readonly streamed: boolean;
}

export class ModelCaller {
  readonly #options: Required<Omit<ModelCallOptions, 'publish'>> & { publish?: PublishEvent };

  constructor(options: ModelCallOptions = {}) {
    this.#options = {
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
      baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
      maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
      now: options.now ?? (() => Date.now()),
      ...(options.publish !== undefined ? { publish: options.publish } : {}),
    };
  }

  /**
   * Runs the primary attempt, retrying transient failures, then the fallback.
   *
   * The fallback is tried ONCE. If a second model is also failing, the problem
   * is not the model, and a run should surface that rather than work through a
   * list.
   */
  async call(
    attempts: readonly ModelAttempt[],
    signal: AbortSignal,
  ): Promise<ModelCallResult> {
    if (attempts.length === 0) {
      throw new Error('A model call needs at least one attempt to make.');
    }

    const started = this.#options.now();
    let total = 0;
    let last: ProviderError | undefined;

    for (const [index, attempt] of attempts.entries()) {
      // Only the primary is retried; a fallback that also fails is a signal,
      // not something to keep trying.
      const budget = attempt.label === 'primary' ? this.#options.maxAttempts : 1;

      for (let tries = 0; tries < budget; tries++) {
        total += 1;
        const outcome = await this.#stream(attempt, signal);

        if (outcome.result !== undefined) {
          return {
            ...outcome.result,
            attempts: total,
            usedFallback: index > 0,
            latencyMs: this.#options.now() - started,
          };
        }

        const error = outcome.error as ProviderError;
        last = error;

        // Committed: text is already on the user's screen.
        if (outcome.streamed) throw new ModelCallError(error, total, true);
        if (!error.retryable) break;
        if (tries + 1 >= budget) break;

        await this.#options.sleep(
          error.retryAfterMs ??
            backoffMs(tries, {
              baseDelayMs: this.#options.baseDelayMs,
              maxDelayMs: this.#options.maxDelayMs,
              random: this.#options.random,
            }),
        );
      }

      // A non-retryable failure that is the model's own fault — a rejected
      // request, a refused key — will fail identically on the fallback.
      if (last !== undefined && !isWorthFallingBackFrom(last)) break;
    }

    throw new ModelCallError(
      last ?? { kind: 'unknown', message: 'The model produced no result.', retryable: false },
      total,
      false,
    );
  }

  async #stream(attempt: ModelAttempt, signal: AbortSignal): Promise<StreamOutcome> {
    const publish = this.#options.publish;
    let usage: Usage = emptyUsage;
    let streamed = false;

    try {
      for await (const event of attempt.provider.generate(attempt.request, signal)) {
        switch (event.type) {
          case 'text_delta':
            streamed = true;
            await publish?.('text_delta', { text: event.text });
            break;

          case 'reasoning_delta':
            // A reasoning summary is shown but is not the answer; replaying it
            // on a retry is harmless, so it does not commit the attempt.
            await publish?.('reasoning_delta', { text: event.text });
            break;

          case 'tool_use_start':
            await publish?.('tool_call_started', { id: event.id, name: event.name });
            break;

          case 'usage':
            // Accumulated as it arrives: a stream that fails later still cost
            // what it had spent by then.
            usage = addUsage(usage, event.usage);
            break;

          case 'finish':
            return {
              result: {
                content: event.content,
                ...(event.providerArtifacts !== undefined
                  ? { providerArtifacts: event.providerArtifacts }
                  : {}),
                finishReason: event.reason,
                usage: addUsage(usage, event.usage),
                attempts: 0,
                usedFallback: false,
                latencyMs: 0,
              },
              streamed,
            };

          case 'error':
            return { error: event.error, streamed };

          default:
            break;
        }
      }
    } catch (error) {
      return { error: asProviderError(error), streamed };
    }

    // The stream ended without finishing. Silence here would become a truncated
    // answer the user has no way to distinguish from a complete one.
    return {
      error: {
        kind: 'transport',
        message:
          'The model stream ended without a completion event. The response is incomplete.',
        retryable: true,
      },
      streamed,
    };
  }
}

/**
 * Is a second model worth trying?
 *
 * Only for failures that are about THIS model or its capacity. A malformed
 * request or a content filter will land identically on the next one, and
 * running the list wastes the user's time to reach the same answer.
 */
function isWorthFallingBackFrom(error: ProviderError): boolean {
  switch (error.kind) {
    case 'rate_limit':
    case 'overloaded':
    case 'transport':
    case 'authentication':
    case 'context_length':
      return true;
    case 'content_filter':
    case 'refusal':
    case 'invalid_request':
    case 'unknown':
      return false;
  }
}
