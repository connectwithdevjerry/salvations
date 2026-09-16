/**
 * One way to answer a request, and one way to fail.
 *
 * Every route funnels errors through here so that:
 *
 *   - the shape is identical everywhere and the UI parses one thing;
 *   - a domain error's `expose` flag decides whether its message reaches a
 *     user, rather than each handler deciding again;
 *   - an unexpected error becomes a generic 500 rather than leaking a stack, a
 *     driver message, or the shape of a query.
 *
 * An error string is a classic accidental disclosure channel, and the place it
 * leaks from is always the handler someone wrote in a hurry.
 */
import { ZodError } from 'zod';
import { DomainError, publicMessageOf, type ErrorCode } from '@salvations/core';

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  // Never 403: a distinct status would confirm that another tenant's row
  // exists.
  tenant_violation: 404,
  budget_exhausted: 429,
  capability_not_approved: 403,
  capability_changed: 409,
  permission_denied: 403,
  provider_error: 502,
  mcp_error: 502,
  lease_lost: 409,
  unsupported: 501,
  internal: 500,
});

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

function build(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return Response.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } } satisfies ErrorBody,
    { status },
  );
}

export const errorResponse = Object.assign(build, {
  /**
   * Turns any thrown value into a response.
   *
   * Validation failures are reported field by field because the caller can fix
   * them; everything unrecognised is reported generically because the caller
   * cannot, and the detail would only help someone probing.
   */
  fromUnknown(error: unknown): Response {
    if (error instanceof ZodError) {
      return build(422, 'validation_failed', 'The request body is not valid.', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    if (error instanceof DomainError) {
      return build(
        STATUS_BY_CODE[error.code] ?? 500,
        error.code,
        publicMessageOf(error),
        error.expose && Object.keys(error.details).length > 0
          ? { ...error.details }
          : undefined,
      );
    }

    // Logged in full, reported in outline.
    console.error('[unhandled]', error);
    return build(500, 'internal', 'Something went wrong.');
  },
});

/** Parses and validates a JSON body, or throws a ZodError the funnel handles. */
export async function jsonBody<T>(
  request: Request,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const raw = await request.text();
  const parsed = raw.trim() === '' ? {} : JSON.parse(raw);
  return schema.parse(parsed);
}

export const ok = <T>(body: T, status = 200): Response => Response.json(body, { status });
