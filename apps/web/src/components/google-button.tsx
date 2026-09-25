'use client';

import { useEffect, useState } from 'react';
import { auth } from '@/lib/client/auth';

/**
 * Sign in with Google.
 *
 * Hidden entirely when the deployment has no Google credentials, rather than
 * shown and failing on click: an offer that cannot be honoured is worse than no
 * offer. Whether it is configured is discovered by asking the server, because
 * the client has no way to know and must not be told the client id up front.
 */
export function GoogleButton({ returnTo }: { returnTo?: string }) {
  const [available, setAvailable] = useState<boolean>();

  useEffect(() => {
    fetch('/api/auth/google/available')
      .then((r) => r.json())
      .then((body: { available?: boolean }) => setAvailable(body.available === true))
      .catch(() => setAvailable(false));
  }, []);

  if (available !== true) return null;

  return (
    <button
      type="button"
      className="google"
      onClick={() => auth.startGoogle(returnTo)}
      style={{ width: '100%' }}
    >
      <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden focusable="false">
        <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-3.9H24v7.1h12c-.2 1.8-1.5 4.6-4.3 6.4l6.6 5.1C42.2 35 45 30 45 24z" />
        <path fill="#34A853" d="M24 46c5.8 0 10.7-1.9 14.3-5.2l-6.8-5.3c-1.8 1.3-4.3 2.1-7.5 2.1-5.7 0-10.6-3.8-12.3-9l-7 5.4C8.2 41.1 15.5 46 24 46z" />
        <path fill="#FBBC05" d="M11.7 28.6c-.5-1.3-.7-2.7-.7-4.1s.3-2.8.7-4.1l-7-5.4C3.7 17.7 3 20.7 3 24s.7 6.3 1.7 9z" />
        <path fill="#EA4335" d="M24 10.8c3.2 0 5.4 1.4 6.6 2.5l5.9-5.8C32.9 4.1 28.6 2 24 2 15.5 2 8.2 6.9 4.7 15l7 5.4c1.7-5.2 6.6-9 12.3-9.6z" />
      </svg>
      Continue with Google
    </button>
  );
}
