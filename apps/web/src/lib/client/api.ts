'use client';

/**
 * The browser's side of the API.
 *
 * One place that knows the URL shape and the error shape, so a component never
 * parses a response body by hand. Errors arrive as a typed `ApiError` and are
 * thrown, because a component that has to check a discriminant on every call
 * eventually forgets to on one of them.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'internal',
      // Falls back to something a person can act on rather than to the status
      // number, which tells a user nothing.
      error?.message ?? 'The request failed. Try again in a moment.',
      error?.details,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export const ws = (workspaceId: string) => `/api/workspaces/${workspaceId}`;
