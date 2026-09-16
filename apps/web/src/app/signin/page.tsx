'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SIGN_IN_ERRORS, auth } from '@/lib/client/auth';
import { ApiError } from '@/lib/client/api';
import { GoogleButton } from '@/components/google-button';

/**
 * The reason a Google sign-in bounced back, if there was one.
 *
 * Isolated in its own Suspense boundary because `useSearchParams` opts whatever
 * contains it out of server rendering. Wrapping the whole page meant the served
 * HTML was the word "Loading" — every visitor saw a blank card first, and a
 * crawler or a smoke test saw nothing at all.
 */
function CallbackError() {
  const reason = useSearchParams().get('error');
  const message = SIGN_IN_ERRORS[reason ?? ''];
  return message === undefined ? null : <p className="error">{message}</p>;
}

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await auth.signIn({ email, password });
      router.push('/');
    } catch (caught) {
      // The server already refuses to say whether the address exists; repeating
      // its message keeps the client from inventing a more helpful one.
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Sign in</h2>

        <Suspense fallback={null}>
          <CallbackError />
        </Suspense>

        <GoogleButton returnTo="/" />

        <div className="divider"><span>or</span></div>

        <form className="stack" onSubmit={submit}>
          <div>
            <label htmlFor="email">Email</label>
            <input
              id="email" type="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error !== undefined && <p className="error">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="muted" style={{ marginBottom: 0 }}>
          No account? <Link href="/signup">Create one</Link>
        </p>
      </div>
    </div>
  );
}
