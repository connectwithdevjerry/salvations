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

/**
 * One refresh, then retry.
 *
 * The access cookie lives fifteen minutes. Without this, the app worked for
 * fifteen minutes after sign-in and then answered "Not signed in." to every
 * request until the person signed in again — the refresh endpoint existed and
 * nothing ever called it. Serialised through one promise so a burst of 401s
 * from a page loading five things spends one refresh grant, not five: the
 * refresh token is single-use, and five concurrent rotations would revoke the
 * session as a suspected theft.
 */
let refreshing: Promise<boolean> | undefined;

function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST' })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => { refreshing = undefined; });
  return refreshing;
}

/** Where to send somebody whose session is gone, remembering where they were. */
function toSignIn(): void {
  if (typeof window === 'undefined') return;
  const here = `${window.location.pathname}${window.location.search}`;
  const returnTo = here.startsWith('/signin') || here.startsWith('/signup') ? '' : here;
  window.location.assign(
    returnTo === '' ? '/signin' : `/signin?returnTo=${encodeURIComponent(returnTo)}`,
  );
}

/** Endpoints that are ABOUT signing in. A 401 from these is the answer, not a lapse. */
const isAuthPath = (path: string): boolean => path.startsWith('/api/auth/');

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const send = () => fetch(path, {
    ...init,
    headers: {
      ...(init.body !== undefined && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });

  let response = await send();

  if (response.status === 401 && !isAuthPath(path)) {
    if (await refreshSession()) {
      response = await send();
    } else {
      toSignIn();
    }
  }

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
  /** A multipart upload. The browser sets the boundary, so no content type here. */
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
};

export const ws = (workspaceId: string) => `/api/workspaces/${workspaceId}`;
