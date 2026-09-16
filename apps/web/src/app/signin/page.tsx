'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SIGN_IN_ERRORS, auth } from '@/lib/client/auth';
import { ApiError } from '@/lib/client/api';
import { GoogleButton } from '@/components/google-button';

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(
    SIGN_IN_ERRORS[params.get('error') ?? ''],
  );
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

export default function SignInPage() {
  // useSearchParams needs a boundary, and without one the whole page opts into
  // client rendering at the root.
  return (
    <Suspense fallback={<div className="centered"><p className="muted">Loading…</p></div>}>
      <SignInForm />
    </Suspense>
  );
}
