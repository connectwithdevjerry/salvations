/**
 * Multi-Round-Trip Requests.
 *
 * MRTR replaces the deprecated server-initiated `sampling` and `elicitation`
 * calls: instead of the server opening a reverse channel, it returns
 * `resultType: 'input_required'` with a set of embedded requests and an opaque
 * `requestState`, and the client re-issues the ORIGINAL call carrying answers.
 *
 * That shape is much easier to secure — and much easier to suspend. Because a
 * run's state lives in the database, a human can answer hours later and the run
 * resumes correctly, on a different process or after a deploy.
 *
 * This module is the classifier, and it is pure: it decides what each embedded
 * request is and whether we are willing to answer it. The gateway performs the
 * round trip.
 */

/** What an embedded request is asking us to do. */
export type InputRequestKind =
  /** Ask a human a question. Suspends the run. */
  | 'human'
  /** Run inference on the server's behalf. Denied by default — see below. */
  | 'inference'
  /** Enumerate filesystem roots. Deprecated upstream and not exposed here. */
  | 'roots'
  /** Something we do not recognise. */
  | 'unknown';

export interface ClassifiedInputRequest {
  readonly key: string;
  readonly kind: InputRequestKind;
  readonly method: string;
  readonly params: unknown;
}

export function classifyInputRequest(key: string, request: unknown): ClassifiedInputRequest {
  const method = String((request as { method?: unknown } | undefined)?.method ?? '');
  const params = (request as { params?: unknown } | undefined)?.params;

  const kind: InputRequestKind =
    method === 'elicitation/create' ? 'human'
    : method === 'sampling/createMessage' ? 'inference'
    : method === 'roots/list' ? 'roots'
    : 'unknown';

  return { key, kind, method, params };
}

export const classifyInputRequests = (
  requests: Readonly<Record<string, unknown>> | undefined,
): ClassifiedInputRequest[] =>
  Object.entries(requests ?? {}).map(([key, request]) => classifyInputRequest(key, request));

/** Per-binding opt-ins. Everything defaults to the restrictive setting. */
export interface MrtrPolicy {
  /**
   * Whether this binding may have us run inference on its behalf.
   *
   * DENIED BY DEFAULT. This is the deprecated `sampling` capability wearing a
   * new hat: enabling it lets a third-party server spend our model budget,
   * with prompts it controls, attributed to a workspace that never saw them.
   * Turning it on is an explicit per-binding decision that is charged, budgeted
   * and audited.
   */
  readonly allowInference: boolean;
  /** Whether a human may be interrupted to answer this server. */
  readonly allowHumanInput: boolean;
  readonly maxRounds: number;
}

export const DEFAULT_MRTR_POLICY: MrtrPolicy = Object.freeze({
  allowInference: false,
  allowHumanInput: true,
  maxRounds: 4,
});

export type MrtrDecision =
  /** Every request can be answered without leaving the runtime. */
  | { readonly kind: 'auto'; readonly requests: readonly ClassifiedInputRequest[] }
  /** A human must answer. The run suspends. */
  | { readonly kind: 'needs_human'; readonly requests: readonly ClassifiedInputRequest[] }
  /** We refuse. The reason is returned to the model as a tool error. */
  | { readonly kind: 'refuse'; readonly reason: string };

/**
 * Decides how to answer a set of embedded requests.
 *
 * Refusal wins over everything else: if any single request is one we will not
 * answer, the whole round trip is refused rather than partially satisfied. A
 * partial answer would leave the server believing it had consent it does not
 * have.
 */
export function decideMrtr(
  requests: readonly ClassifiedInputRequest[],
  policy: MrtrPolicy,
  roundsSoFar: number,
): MrtrDecision {
  if (roundsSoFar >= policy.maxRounds) {
    return {
      kind: 'refuse',
      reason:
        `This tool asked for input ${roundsSoFar} times, which exceeds the limit of ` +
        `${policy.maxRounds}. A server that keeps asking is either misbehaving or stuck.`,
    };
  }

  if (requests.length === 0) {
    return {
      kind: 'refuse',
      reason: 'The server asked for input but named no requests, so there is nothing to answer.',
    };
  }

  for (const request of requests) {
    if (request.kind === 'inference' && !policy.allowInference) {
      return {
        kind: 'refuse',
        reason:
          'This server asked the host to run a model on its behalf. That is denied by default: ' +
          'it would spend the workspace budget on prompts the server controls. An administrator ' +
          'can enable it for this specific server.',
      };
    }
    if (request.kind === 'human' && !policy.allowHumanInput) {
      return {
        kind: 'refuse',
        reason: 'This server asked to interrupt a person, which is disabled for it.',
      };
    }
    if (request.kind === 'roots') {
      return {
        kind: 'refuse',
        reason:
          'This server asked for filesystem roots. That capability is deprecated in the ' +
          'protocol and is not exposed by this host.',
      };
    }
    if (request.kind === 'unknown') {
      return {
        kind: 'refuse',
        reason:
          `This server asked for "${request.method}", which this host does not recognise. ` +
          'Answering an unrecognised request would mean guessing what it consents to.',
      };
    }
  }

  const needsHuman = requests.some((r) => r.kind === 'human');
  return needsHuman
    ? { kind: 'needs_human', requests }
    : { kind: 'auto', requests };
}

/**
 * Carries an in-flight round trip across a suspension.
 *
 * `requestState` is OPAQUE: minted by the server, echoed back verbatim, never
 * parsed and never logged in full. It can encode anything the server likes,
 * including data it would not want in our logs, and any assumption about its
 * structure would break on a server that changed its mind.
 */
export interface MrtrContinuation {
  readonly requestState: string | undefined;
  readonly rounds: number;
  readonly pending: readonly ClassifiedInputRequest[];
}

/** A short, non-reversible marker safe to put in an audit record. */
export const requestStateFingerprint = (state: string | undefined): string =>
  state === undefined || state === '' ? 'none' : `len:${state.length}`;

export const isInputRequired = (result: unknown): boolean =>
  typeof result === 'object' && result !== null &&
  (result as { resultType?: unknown }).resultType === 'input_required';
