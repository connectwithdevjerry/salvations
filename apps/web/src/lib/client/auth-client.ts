'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * The browser's auth client.
 *
 * No baseURL: the app is served from the same origin as its auth routes, and
 * hard-coding one is how a preview deployment ends up posting credentials to
 * production.
 */
export const authClient = createAuthClient();
