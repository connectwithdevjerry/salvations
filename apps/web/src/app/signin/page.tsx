'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/client/auth-client';

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

    const result = await authClient.signIn.email({ email, password });
    setBusy(false);

    if (result.error !== null && result.error !== undefined) {
      // One message for every failure. Saying whether the address exists turns
      // the sign-in form into an account-enumeration oracle.
      setError('That email and password do not match an account.');
      return;
    }
    router.push('/');
  }

  return (
    <div className="centered">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Sign in</h2>
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
