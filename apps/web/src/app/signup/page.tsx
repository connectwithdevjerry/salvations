'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/client/auth-client';

/** Matches the server's floor. Stated here so the form can say so up front. */
const MIN_PASSWORD_LENGTH = 12;

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    setError(undefined);
    const result = await authClient.signUp.email({ email, password, name });
    setBusy(false);

    if (result.error !== null && result.error !== undefined) {
      setError(result.error.message ?? 'That account could not be created.');
      return;
    }
    router.push('/');
  }

  return (
    <div className="centered">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Create an account</h2>
        <form className="stack" onSubmit={submit}>
          <div>
            <label htmlFor="name">Name</label>
            <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
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
              id="password" type="password" autoComplete="new-password" required
              minLength={MIN_PASSWORD_LENGTH}
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
            <p className="muted">At least {MIN_PASSWORD_LENGTH} characters.</p>
          </div>
          {error !== undefined && <p className="error">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
        <p className="muted" style={{ marginBottom: 0 }}>
          Already have one? <Link href="/signin">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
