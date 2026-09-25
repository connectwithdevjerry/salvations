'use client';

import { api } from './api';

/**
 * The browser's side of authentication.
 *
 * Deliberately thin. The session lives in httpOnly cookies the browser attaches
 * on its own, so there is no token for this file to hold — which is the point:
 * a token this code could read is a token an XSS bug could steal.
 */
export interface SignedInUser {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly imageUrl?: string;
  readonly emailVerified: boolean;
  /** Whether the product walkthrough has been finished or skipped. */
  readonly walkthroughSeen: boolean;
}

export const auth = {
  signUp: (input: { email: string; password: string; name?: string }) =>
    api.post<{ userId: string }>('/api/auth/signup', input),

  signIn: (input: { email: string; password: string }) =>
    api.post<{ userId: string }>('/api/auth/signin', input),

  signOut: () => api.post<{ signedOut: boolean }>('/api/auth/signout'),

  session: () => api.get<{ user: SignedInUser | null }>('/api/auth/session'),

  /** Emails a six-digit code to the signed-in address. */
  sendVerificationCode: () => api.post<{ sent: boolean; to: string; expiresAt: string }>('/api/auth/verify/send'),

  /** Presents the code. On success the address is verified. */
  confirmVerificationCode: (code: string) =>
    api.post<{ verified: boolean }>('/api/auth/verify/confirm', { code }),

  /** Remembers, on the account, that the walkthrough was seen. */
  markWalkthroughSeen: () => api.post<{ seen: boolean }>('/api/auth/session/walkthrough'),

  /**
   * A full navigation, not a fetch.
   *
   * The OAuth flow is a redirect to Google and back; XHR cannot do it, and
   * attempting it just gets a CORS failure instead of a sign-in.
   */
  startGoogle: (returnTo?: string) => {
    const url = new URL('/api/auth/google/start', window.location.origin);
    if (returnTo !== undefined) url.searchParams.set('returnTo', returnTo);
    window.location.assign(url.toString());
  },
};

/** Messages for the reasons the Google callback can bounce someone back. */
export const SIGN_IN_ERRORS: Readonly<Record<string, string>> = {
  google_denied: 'You cancelled the Google sign-in.',
  google_expired: 'That sign-in took too long. Try again.',
  google_incomplete: 'Google sent an incomplete response. Try again.',
  google_unverified:
    'Google has not verified that email address, so it cannot be used to sign in here.',
  google_failed: 'That Google sign-in could not be completed.',
  account_disabled: 'This account has been disabled.',
};
