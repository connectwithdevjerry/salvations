/**
 * Domain errors.
 *
 * Every error carries a stable `code` so callers branch on identity rather than
 * message text, and an `expose` flag deciding whether the message may reach an
 * end user. Anything not explicitly exposed is reported generically — an error
 * string is a classic accidental disclosure channel.
 */

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'tenant_violation'
  | 'budget_exhausted'
  | 'capability_not_approved'
  | 'capability_changed'
  | 'permission_denied'
  | 'provider_error'
  | 'mcp_error'
  | 'lease_lost'
  | 'unsupported'
  | 'internal';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly expose: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { expose?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DomainError';
    this.code = code;
    this.expose = options.expose ?? false;
    this.details = Object.freeze({ ...options.details });
  }
}

const make =
  (code: ErrorCode, expose: boolean) =>
  (message: string, details?: Record<string, unknown>): DomainError =>
    new DomainError(code, message, details !== undefined ? { expose, details } : { expose });

export const Errors = {
  unauthenticated: make('unauthenticated', true),
  forbidden: make('forbidden', true),
  notFound: make('not_found', true),
  conflict: make('conflict', true),
  validation: make('validation_failed', true),
  /** Never exposed: the message would confirm another tenant's data exists. */
  tenantViolation: make('tenant_violation', false),
  budgetExhausted: make('budget_exhausted', true),
  capabilityNotApproved: make('capability_not_approved', true),
  capabilityChanged: make('capability_changed', true),
  permissionDenied: make('permission_denied', true),
  providerError: make('provider_error', false),
  mcpError: make('mcp_error', false),
  leaseLost: make('lease_lost', false),
  unsupported: make('unsupported', true),
  internal: make('internal', false),
} as const;

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError;

export const errorCodeOf = (e: unknown): ErrorCode =>
  isDomainError(e) ? e.code : 'internal';

/** Message safe to return to a caller. */
export const publicMessageOf = (e: unknown): string =>
  isDomainError(e) && e.expose ? e.message : 'An internal error occurred.';
